# Copyright 2026 Marimo. All rights reserved.

"""Generate Effect `Schema` definitions from owned msgspec protocol types.

Walks msgspec's introspection IR (`msgspec.inspect`) directly — no JSON Schema
round-trip — and emits `extension/src/schemas/Models.gen.ts` so the TypeScript
side *parses* our own wire types instead of assuming them.

The generated named client validates the owned tagged command union before it
crosses the private LSP request and validates each declared response.

Run through the repository codegen entry point: ``just codegen``.
"""

from __future__ import annotations

import inspect as pyinspect
import json

import msgspec
import msgspec.inspect as mi

from marimo_lsp import models, protocol
from marimo_lsp.api import COMMANDS, CommandSpec
from scripts.codegen.output import EXTENSION

OUTPUT = EXTENSION / "src" / "schemas" / "Models.gen.ts"
LABEL = "Effect schemas"

HEADER = """\
// AUTO-GENERATED FILE — DO NOT EDIT.
//
// Generated from `src/marimo_lsp/protocol.py`, `src/marimo_lsp/models.py`,
// and the command registry (`COMMANDS` in `src/marimo_lsp/api.py`)
// by `scripts.codegen`.
// Regenerate with `just codegen`.
import type { components as MarimoApi } from "@marimo-team/openapi/src/api";
import { Effect, Schema } from "effect";

type MarimoNotification = MarimoApi["schemas"]["KnownUnions"]["notification"];
const MarimoNotification = Schema.declare<MarimoNotification>(
  (value): value is MarimoNotification =>
    typeof value === "object" &&
    value !== null &&
    "op" in value &&
    typeof value.op === "string",
);

type CellOperationNotification = Extract<
  MarimoNotification,
  { op: "cell-op" }
>;
const CellOperationNotification = Schema.declare<CellOperationNotification>(
  (value): value is CellOperationNotification =>
    Schema.is(MarimoNotification)(value) && value.op === "cell-op",
);

type VariablesNotification = Extract<MarimoNotification, { op: "variables" }>;
const VariablesNotification = Schema.declare<VariablesNotification>(
  (value): value is VariablesNotification =>
    Schema.is(MarimoNotification)(value) && value.op === "variables",
);

// The id is an opaque token minted by the server; only equality matters.
// Validating its shape here would turn a harmless server-side format
// change into silently dropped notifications.
export const KernelSessionIdFromString = Schema.String.pipe(
  Schema.brand("KernelSessionId"),
);
export type KernelSessionId = typeof KernelSessionIdFromString.Type;

export const NotebookIdFromString = Schema.String.pipe(
  Schema.brand("NotebookId"),
);
export type NotebookId = typeof NotebookIdFromString.Type;
"""


_StructLike = mi.StructType | mi.DataclassType | mi.TypedDictType
"""IR nodes with a `cls` and `fields` that emit as `Schema.Struct`."""

# (exported name, type) pairs. The emitter topologically orders dependencies.
CONCRETE: list[tuple[str, type | object]] = [
    ("Command", protocol.Command),
    ("AppOptions", protocol.AppOptions),
    ("KernelNotification", models.KernelNotification),
    ("DocumentAnalysis", models.DocumentAnalysis),
    ("CellMetadata", models.CellMetadata),
    ("NotebookDocumentMetadata", models.NotebookDocumentMetadata),
    ("NotebookDocument", models.NotebookDocument),
    ("DeserializeResult", models.DeserializeResult),
    ("ConvertRequest", models.ConvertRequest),
    ("CellOutputReplay", models.CellOutputReplay),
]


def _ts_string(value: str) -> str:
    return json.dumps(value)


def _pascal(name: str) -> str:
    """Convert a kebab-case wire method name to a PascalCase class name."""
    return "".join(part.capitalize() for part in name.split("-"))


def _camel(name: str) -> str:
    """Convert a kebab-case wire method name to a camelCase client method."""
    pascal = _pascal(name)
    return pascal[0].lower() + pascal[1:]


def _prop(name: str) -> str:
    """Render an object property key, quoting when not a valid identifier."""
    if name.isidentifier():
        return name
    return _ts_string(name)


def _ts_literal(value: object) -> str:
    """Render a Python default value as a TS expression."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return _ts_string(value)
    if isinstance(value, (int, float)):
        return repr(value)
    msg = f"unsupported default value: {value!r}"
    raise NotImplementedError(msg)


def _literal_expr(rendered: list[str]) -> str:
    """Render literal members as `Schema.Literal` (one) or `Schema.Literals` (many)."""
    if len(rendered) == 1:
        return f"Schema.Literal({rendered[0]})"
    return f"Schema.Literals([{', '.join(rendered)}])"


def _jsdoc(doc: str | None, indent: str = "") -> str:
    if not doc:
        return ""
    lines = pyinspect.cleandoc(doc).splitlines()
    body = "\n".join(f"{indent} * {line}".rstrip() for line in lines)
    return f"{indent}/**\n{body}\n{indent} */\n"


def _annotations(cls: type, name: str) -> str:
    """Emit identity and excess-property policy for an owned wire struct."""
    annotations = [f"identifier: {_ts_string(name)}"]
    if getattr(cls, "__preserve_unknown_fields__", False):
        annotations.append('parseOptions: { onExcessProperty: "preserve" }')
    elif (
        isinstance(cls, type)
        and issubclass(cls, msgspec.Struct)
        and cls.__struct_config__.forbid_unknown_fields
    ):
        annotations.append('parseOptions: { onExcessProperty: "error" }')
    return f".annotate({{ {', '.join(annotations)} }})"


def _identifier(name: str) -> str:
    """Annotate a non-struct schema with its generated name."""
    return f".annotate({{ identifier: {_ts_string(name)} }})"


class Emitter:
    """Accumulates TS definitions while resolving msgspec type IR."""

    def __init__(self) -> None:
        self.definitions: list[str] = []
        self.emitted: dict[type, str] = {}
        self.alias_by_expr: dict[str, str] = {}
        self.in_flight: set[type] = set()
        self.recursive: set[type] = set()
        # These two brands predate first-class protocol metadata and remain in
        # the static header while legacy models migrate to the owned protocol.
        self.brand_schemas: dict[str, str] = {
            "KernelSessionId": "KernelSessionIdFromString",
            "NotebookId": "NotebookIdFromString",
        }

    @staticmethod
    def metadata_brand(t: mi.Type) -> object | None:
        """Return the owned brand attached to a msgspec metadata node."""
        if not isinstance(t, mi.Metadata) or t.extra_json_schema is None:
            return None
        return t.extra_json_schema.get(protocol.BRAND_METADATA_KEY)

    # Exhaustive dispatch over msgspec's IR node types is a flat switch by
    # design; splitting it up would hide the one-to-one mapping this encodes.
    def type_expr(self, t: mi.Type) -> str:  # noqa: C901, PLR0911, PLR0912
        """Render a msgspec IR node as an Effect Schema expression."""
        match t:
            case mi.AnyType() | mi.RawType():
                return "Schema.Unknown"
            case mi.CustomType(cls=cls) if cls is object:
                return "Schema.Unknown"
            case mi.NoneType():
                return "Schema.Null"
            case mi.BoolType():
                return "Schema.Boolean"
            case mi.IntType():
                return "Schema.Int"
            case mi.FloatType():
                return "Schema.Number"
            case mi.StrType():
                return "Schema.String"
            case mi.BytesType() | mi.ByteArrayType():
                return self.base64_ref()
            case mi.LiteralType(values=values):
                return _literal_expr([_ts_string(str(v)) for v in values])
            case mi.EnumType(cls=cls):
                return _literal_expr([_ts_string(member.value) for member in cls])
            case mi.DictType(key_type=key, value_type=value):
                return f"Schema.Record({self.type_expr(key)}, {self.type_expr(value)})"
            case (
                mi.ListType(item_type=item)
                | mi.SetType(item_type=item)
                | mi.VarTupleType(item_type=item)
            ):
                return f"Schema.Array({self.type_expr(item)})"
            case mi.TupleType(item_types=items):
                args = ", ".join(self.type_expr(i) for i in items)
                return f"Schema.Tuple([{args}])"
            case mi.Metadata(type=inner):
                brand = self.metadata_brand(t)
                if brand is not None:
                    return self.brand_ref(brand, inner)
                # Other `msgspec.Meta` constraints are already folded into the
                # inner node.
                return self.type_expr(inner)
            case mi.UnionType(types=types):
                return self.union_expr(list(types))
            case mi.StructType() | mi.DataclassType() | mi.TypedDictType():
                return self.struct_ref(t)
            case _:
                msg = f"no Effect Schema mapping for {type(t).__name__}"
                raise NotImplementedError(msg)

    def union_expr(self, types: list[mi.Type]) -> str:
        rest = [t for t in types if not isinstance(t, mi.NoneType)]
        nullable = len(rest) != len(types)
        inner = (
            self.type_expr(rest[0])
            if len(rest) == 1
            else f"Schema.Union([{', '.join(self.type_expr(t) for t in rest)}])"
        )
        inner = self.alias_by_expr.get(inner, inner)
        return f"Schema.NullOr({inner})" if nullable else inner

    def base64_ref(self) -> str:
        """Emit the shared brand for msgspec `bytes` fields (base64 on the JSON wire)."""
        name = "Base64String"
        if bytes not in self.emitted:
            self.emitted[bytes] = name
            self.definitions.append(
                "/**\n"
                " * Base64-encoded bytes on the msgspec JSON wire.\n"
                " *\n"
                ' * Matches the compile-time `TypedString<"Base64String">` brand emitted\n'
                " * by `@marimo-team/openapi`. Decode with `Schema.Uint8ArrayFromBase64`\n"
                " * where actual bytes are needed.\n"
                " */\n"
                f'export const {name} = Schema.String.pipe(Schema.brand("{name}"));\n'
                f"export type {name} = typeof {name}.Type;\n"
            )
        return name

    def brand_ref(self, brand: object, inner: mi.Type) -> str:
        """Emit or reference an owned nominal string schema."""
        if not isinstance(brand, str) or not brand.isidentifier():
            msg = f"invalid owned brand name: {brand!r}"
            raise ValueError(msg)
        if not isinstance(inner, mi.StrType):
            msg = f"owned brand {brand!r} must annotate a string"
            raise TypeError(msg)

        schema_name = self.brand_schemas.get(brand)
        if schema_name is not None:
            return schema_name

        schema_name = f"{brand}FromString"
        self.brand_schemas[brand] = schema_name
        self.definitions.append(
            f'export const {schema_name} = Schema.String.pipe(Schema.brand("{brand}"));\n'
            f"export type {brand} = typeof {schema_name}.Type;\n"
        )
        return schema_name

    def struct_ref(self, t: _StructLike) -> str:
        """Emit a struct/dataclass/TypedDict definition (once); return its name."""
        cls = t.cls
        if cls in self.emitted:
            name = self.emitted[cls]
            if cls in self.in_flight:
                # A cycle back into a definition we're still emitting: defer
                # the reference so the const can close over itself.
                self.recursive.add(cls)
                return f"Schema.suspend((): Schema.Codec<{name}> => {name})"
            return name
        name = cls.__name__
        self.emitted[cls] = name
        self.in_flight.add(cls)
        try:
            fields = self.fields_src(t, indent="  ")
        finally:
            self.in_flight.discard(cls)
        struct = f"Schema.Struct({{\n{fields}}})" if fields else "Schema.Struct({})"
        annotations = _annotations(cls, name)
        if cls in self.recursive:
            # Recursive schemas need an explicit type: `typeof X.Type` cannot
            # refer to itself, so emit a structural interface alongside. The
            # const's own type stays inferred; the annotated `Schema.suspend`
            # closure breaks the reference cycle (see the v4 `suspend` docs).
            self.definitions.append(
                f"{_jsdoc(cls.__doc__)}"
                f"export interface {name} {{\n{self.interface_fields(t)}}}\n"
                f"export const {name} = {struct}{annotations};\n"
            )
        else:
            self.definitions.append(
                f"{_jsdoc(cls.__doc__)}"
                f"export const {name} = {struct}{annotations};\n"
                f"export type {name} = typeof {name}.Type;\n"
            )
        return name

    def interface_fields(self, t: _StructLike) -> str:
        """Render a recursive struct's fields as TS interface members.

        Only the `Type == Encoded` case is supported: a recursive struct with
        renamed, optional, or defaulted fields would need distinct Type and
        Encoded interfaces (`Schema.Schema<A, I>`).
        """
        lines: list[str] = []
        for field in t.fields:
            if not field.required or field.name != field.encode_name:
                msg = (
                    f"recursive type {t.cls.__name__} has optional/renamed field "
                    f"{field.name!r}; Type/Encoded diverge (unsupported)"
                )
                raise NotImplementedError(msg)
            lines.append(
                f"  readonly {_prop(field.encode_name)}: {self.ts_type(field.type)};"
            )
        return "\n".join(lines) + "\n" if lines else ""

    # Same shape as `type_expr` — the TS-type mirror of each IR node.
    def ts_type(self, t: mi.Type) -> str:  # noqa: C901, PLR0911, PLR0912
        """Render a msgspec IR node as a TS *type* (for recursive interfaces)."""
        match t:
            case mi.AnyType() | mi.RawType():
                return "unknown"
            case mi.NoneType():
                return "null"
            case mi.BoolType():
                return "boolean"
            case mi.IntType() | mi.FloatType():
                return "number"
            case mi.StrType():
                return "string"
            case mi.BytesType() | mi.ByteArrayType():
                return self.base64_ref()
            case mi.LiteralType(values=values):
                return " | ".join(_ts_string(str(v)) for v in values)
            case mi.EnumType(cls=cls):
                return " | ".join(_ts_string(member.value) for member in cls)
            case mi.DictType(key_type=key, value_type=value):
                return (
                    f"{{ readonly [key: {self.ts_type(key)}]: {self.ts_type(value)} }}"
                )
            case (
                mi.ListType(item_type=item)
                | mi.SetType(item_type=item)
                | mi.VarTupleType(item_type=item)
            ):
                return f"ReadonlyArray<{self.ts_type(item)}>"
            case mi.TupleType(item_types=items):
                return f"readonly [{', '.join(self.ts_type(i) for i in items)}]"
            case mi.Metadata(type=inner):
                brand = self.metadata_brand(t)
                if brand is not None:
                    self.brand_ref(brand, inner)
                    if not isinstance(brand, str):  # guarded by brand_ref
                        raise AssertionError
                    return brand
                return self.ts_type(inner)
            case mi.UnionType(types=types):
                return " | ".join(self.ts_type(x) for x in types)
            case mi.StructType() | mi.DataclassType() | mi.TypedDictType():
                # `struct_ref` is memoized; recursive members resolve to the
                # interface name being emitted.
                return self.emitted.get(t.cls) or self.struct_ref(t)
            case _:
                msg = f"no TS type mapping for {type(t).__name__}"
                raise NotImplementedError(msg)

    def field_type_expr(self, t: _StructLike, field: mi.Field) -> str:
        """Resolve one field, including temporary legacy type projections."""
        if self.metadata_brand(field.type) is not None:
            expr = self.type_expr(field.type)
        elif t.cls in {models.LiveCellReplay, models.SavedCellReplay} and (
            field.name == "notification"
        ):
            expr = "CellOperationNotification"
        elif t.cls is models.KernelNotification and field.name == "notification":
            expr = "MarimoNotification"
        elif t.cls is models.DocumentAnalysis and field.name == "analysis":
            expr = "VariablesNotification"
        elif field.name == "notebook_uri":
            expr = "NotebookIdFromString"
        elif field.name == "session_id":
            nullable = isinstance(field.type, mi.UnionType) and any(
                isinstance(member, mi.NoneType) for member in field.type.types
            )
            expr = (
                "Schema.NullOr(KernelSessionIdFromString)"
                if nullable
                else "KernelSessionIdFromString"
            )
        else:
            expr = self.type_expr(field.type)
        return expr

    def fields_src(self, t: _StructLike, indent: str) -> str:
        lines: list[str] = []
        if isinstance(t, mi.StructType) and t.tag_field is not None:
            # This schema describes the encoded wire shape. Although msgspec
            # tolerates an omitted tag when decoding a concrete struct, it
            # requires the discriminator when decoding a tagged union.
            tag = _ts_string(str(t.tag))
            lines.append(f"{indent}{_prop(t.tag_field)}: Schema.Literal({tag}),")
        for field in t.fields:
            expr = self.field_type_expr(t, field)
            prop = _prop(field.encode_name)
            if field.required:
                rendered = expr if prop == expr else f"{prop}: {expr}"
            else:
                default = self.default_expr(field)
                if default is None:
                    rendered = f"{prop}: Schema.optional({expr})"
                else:
                    # v3 `Schema.optionalWith(S, { default })`: the key stays
                    # omittable on the wire; a missing/undefined field decodes
                    # to the default. The default is an *Encoded* value, so
                    # nested struct defaults are filled by the inner decode —
                    # matching msgspec's default_factory semantics.
                    rendered = (
                        f"{prop}: {expr}.pipe("
                        f"Schema.withDecodingDefault(Effect.sync(() => {default}))"
                        f")"
                    )
            lines.append(f"{indent}{rendered},")
        return "\n".join(lines) + "\n" if lines else ""

    def default_expr(self, field: mi.Field) -> str | None:
        """Render the field default so decode fills omitted fields, like msgspec."""
        if field.default is not msgspec.NODEFAULT:
            return _ts_literal(field.default)
        if field.default_factory is not msgspec.NODEFAULT:
            if field.default_factory is dict or isinstance(
                field.type, mi.TypedDictType
            ):
                return "({})"
            if field.default_factory is list:
                return "[]"
            if (
                isinstance(field.type, _StructLike)
                and field.default_factory is field.type.cls
            ):
                # Zero-arg struct construction: every field of the inner
                # struct has a default, so decoding the empty *Encoded*
                # object fills them (see `withDecodingDefault` above).
                return "({})"
        return None

    def emit_named(self, name: str, t: type | object) -> None:
        info = mi.type_info(t)
        if isinstance(info, mi.StructType):
            emitted = self.struct_ref(info)
            if emitted != name:
                msg = f"manifest name {name!r} does not match struct name {emitted!r}"
                raise ValueError(msg)
            return
        expr = self.type_expr(info)
        self.alias_by_expr[expr] = name
        self.definitions.append(
            f"export const {name} = {expr}{_identifier(name)};\n"
            f"export type {name} = typeof {name}.Type;\n"
        )

    def emit_command(self, spec: CommandSpec) -> tuple[str, str, str, str]:
        """Return a command's schema, method, tag, and success schema."""
        info = mi.type_info(spec.request)
        if not isinstance(info, mi.StructType) or info.tag is None:
            msg = f"command {spec.request!r} must be a tagged struct"
            raise TypeError(msg)
        return (
            info.cls.__name__,
            _camel(str(info.tag)),
            str(info.tag),
            self.type_expr(mi.type_info(spec.response)),
        )


_DISPATCH_HELPER = """\
type CommandTransport<E, R> = (
  command: typeof Command.Encoded,
) => Effect.Effect<unknown, E, R>;

/**
 * Validate the complete outgoing command, send it verbatim, and parse the
 * response against the command's declared success schema.
 */
const dispatch = <
  Success extends Schema.Top,
  E,
  R,
>(
  send: CommandTransport<E, R>,
  command: typeof Command.Encoded,
  success: Success,
): Effect.Effect<
  Success["Type"],
  E | Schema.SchemaError,
  R | Success["DecodingServices"]
> =>
  Effect.flatMap(Schema.decodeEffect(Command)(command), () =>
    Effect.flatMap(send(command), Schema.decodeUnknownEffect(success)),
  );
"""


def generate() -> str:
    emitter = Emitter()
    for name, t in CONCRETE:
        emitter.emit_named(name, t)
    commands = [emitter.emit_command(spec) for spec in COMMANDS]
    emitter.definitions.append(_DISPATCH_HELPER)
    methods = "\n".join(
        f'  {method}: (params: Omit<typeof {class_name}.Encoded, "kind">) => {{\n'
        f"    const command = {{ kind: {_ts_string(tag)}, ...params }} "
        f"satisfies typeof {class_name}.Encoded;\n"
        f"    return dispatch(send, command, {success});\n"
        "  },"
        for class_name, method, tag, success in commands
    )
    emitter.definitions.append(
        "/**\n"
        " * Named extension methods over the private owned command protocol.\n"
        " *\n"
        " * Ordinary extension code never constructs or switches over the raw union.\n"
        " */\n"
        "export const makeCommandClient = <E, R>(send: CommandTransport<E, R>) => ({\n"
        f"{methods}\n"
        "});\n"
    )
    return HEADER + "\n" + "\n".join(emitter.definitions)
