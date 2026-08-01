# Copyright 2026 Marimo. All rights reserved.

"""Generate Effect `Schema` definitions from `marimo_lsp.models` msgspec Structs.

Walks msgspec's introspection IR (`msgspec.inspect`) directly — no JSON Schema
round-trip — and emits `extension/src/schemas/Models.gen.ts` so the TypeScript
side *parses* our own wire types instead of assuming them.

Only types owned by marimo-lsp are emitted. Types re-exported from marimo core
(`ExecuteCellsRequest`, ...) stay on the `@marimo-team/openapi` path.

Usage:
    uv run scripts/generate_effect_schemas.py          # write the file
    uv run scripts/generate_effect_schemas.py --check  # exit 1 on drift
"""

from __future__ import annotations

import inspect as pyinspect
import json
import pathlib
import subprocess
import sys
import tempfile

import msgspec
import msgspec.inspect as mi

from marimo_lsp import models
from marimo_lsp.api import API_METHODS, ApiMethod

OUTPUT = (
    pathlib.Path(__file__).parent.parent
    / "extension"
    / "src"
    / "schemas"
    / "Models.gen.ts"
)

HEADER = """\
// AUTO-GENERATED FILE — DO NOT EDIT.
//
// Generated from `src/marimo_lsp/models.py` and the `marimo.api` registry
// (`API_METHODS` in `src/marimo_lsp/api.py`) by `scripts/generate_effect_schemas.py`.
// Regenerate with `just generate-schemas`.
import { Effect, ParseResult, Schema } from "effect";
"""


_StructLike = mi.StructType | mi.DataclassType | mi.TypedDictType
"""IR nodes with a `cls` and `fields` that emit as `Schema.Struct`."""


class _Inner(msgspec.Struct):
    """Placeholder substituted for generic type parameters.

    Fields typed as `_Inner` are emitted as the TS generic parameter `inner`.
    """


# (exported name, type) pairs. The emitter topologically orders dependencies.
CONCRETE: list[tuple[str, type | object]] = [
    ("PackageSource", models.PackageSource),
    ("CellMetadata", models.CellMetadata),
    ("NotebookDocument", models.NotebookDocument),
    ("DeserializeRequest", models.DeserializeRequest),
    ("ConvertRequest", models.ConvertRequest),
    ("InterruptRequest", models.InterruptRequest),
    ("ListPackagesRequest", models.ListPackagesRequest),
    ("DependencyTreeRequest", models.DependencyTreeRequest),
    ("GetConfigurationRequest", models.GetConfigurationRequest),
    ("CloseSessionRequest", models.CloseSessionRequest),
    ("ExportAsIpynbRequest", models.ExportAsIpynbRequest),
    ("ExecuteScratchRequest", models.ExecuteScratchRequest),
    ("UpdateConfigurationRequest", models.UpdateConfigurationRequest),
    ("SetDisplayThemeRequest", models.SetDisplayThemeRequest),
]

# Generic wrappers become TS functions of the `inner` schema. Parameterized
# with the `_Inner` placeholder so msgspec resolves the type variable to a
# marker the emitter can recognize.
GENERIC: list[tuple[type, type]] = [
    (models.NotebookCommand, models.NotebookCommand[_Inner]),
    (models.SessionCommand, models.SessionCommand[_Inner]),
    (models.PackageCommand, models.PackageCommand[_Inner]),
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


def _jsdoc(doc: str | None, indent: str = "") -> str:
    if not doc:
        return ""
    lines = pyinspect.cleandoc(doc).splitlines()
    body = "\n".join(f"{indent} * {line}".rstrip() for line in lines)
    return f"{indent}/**\n{body}\n{indent} */\n"


def _identifier(name: str) -> str:
    """Annotate a schema with its name so parse errors read `Expected <name>`."""
    return f".annotations({{ identifier: {_ts_string(name)} }})"


class Emitter:
    """Accumulates TS definitions while resolving msgspec type IR."""

    def __init__(self) -> None:
        self.definitions: list[str] = []
        self.emitted: dict[type, str] = {}
        self.alias_by_expr: dict[str, str] = {}
        self.in_flight: set[type] = set()
        self.recursive: set[type] = set()

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
                args = ", ".join(_ts_string(str(v)) for v in values)
                return f"Schema.Literal({args})"
            case mi.EnumType(cls=cls):
                args = ", ".join(_ts_string(member.value) for member in cls)
                return f"Schema.Literal({args})"
            case mi.DictType(key_type=key, value_type=value):
                return (
                    "Schema.Record({ "
                    f"key: {self.type_expr(key)}, value: {self.type_expr(value)}"
                    " })"
                )
            case (
                mi.ListType(item_type=item)
                | mi.SetType(item_type=item)
                | mi.VarTupleType(item_type=item)
            ):
                return f"Schema.Array({self.type_expr(item)})"
            case mi.TupleType(item_types=items):
                args = ", ".join(self.type_expr(i) for i in items)
                return f"Schema.Tuple({args})"
            case mi.Metadata(type=inner):
                # `typing.Annotated[..., msgspec.Meta(...)]`; constraints are
                # already folded into the inner node.
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
            else f"Schema.Union({', '.join(self.type_expr(t) for t in rest)})"
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

    def struct_ref(self, t: _StructLike) -> str:
        """Emit a struct/dataclass/TypedDict definition (once); return its name."""
        cls = t.cls
        if cls is _Inner:
            return "inner"
        if cls in self.emitted:
            name = self.emitted[cls]
            if cls in self.in_flight:
                # A cycle back into a definition we're still emitting: defer
                # the reference so the const can close over itself.
                self.recursive.add(cls)
                return f"Schema.suspend((): Schema.Schema<{name}> => {name})"
            return name
        name = cls.__name__
        self.emitted[cls] = name
        self.in_flight.add(cls)
        try:
            fields = self.fields_src(t, indent="  ")
        finally:
            self.in_flight.discard(cls)
        struct = f"Schema.Struct({{\n{fields}}})" if fields else "Schema.Struct({})"
        identifier = _identifier(name)
        if cls in self.recursive:
            # Recursive schemas need an explicit type: `typeof X.Type` cannot
            # refer to itself, so emit a structural interface alongside.
            self.definitions.append(
                f"{_jsdoc(cls.__doc__)}"
                f"export interface {name} {{\n{self.interface_fields(t)}}}\n"
                f"export const {name}: Schema.Schema<{name}> = {struct}{identifier};\n"
            )
        else:
            self.definitions.append(
                f"{_jsdoc(cls.__doc__)}"
                f"export const {name} = {struct}{identifier};\n"
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

    def fields_src(self, t: _StructLike, indent: str) -> str:
        lines: list[str] = []
        if isinstance(t, mi.StructType) and t.tag_field is not None:
            # This schema describes the encoded wire shape. Although msgspec
            # tolerates an omitted tag when decoding a concrete struct, it
            # requires the discriminator when decoding a tagged union.
            tag = _ts_string(str(t.tag))
            lines.append(f"{indent}{_prop(t.tag_field)}: Schema.Literal({tag}),")
        for field in t.fields:
            expr = self.type_expr(field.type)
            prop = _prop(field.encode_name)
            if field.required:
                rendered = expr if prop == expr else f"{prop}: {expr}"
            else:
                default = self.default_expr(field)
                if default is None:
                    rendered = f"{prop}: Schema.optional({expr})"
                else:
                    rendered = f"{prop}: Schema.optionalWith({expr}, {{ default: () => {default} }})"
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

    def emit_generic(self, cls: type, parameterized: type) -> None:
        info = mi.type_info(parameterized)
        if not isinstance(info, mi.StructType):
            msg = f"expected a struct, got {type(info).__name__}"
            raise TypeError(msg)
        fields = self.fields_src(info, indent="    ")
        self.definitions.append(
            f"{_jsdoc(cls.__doc__)}"
            f"export const {cls.__name__} = <S extends Schema.Schema.Any>(inner: S) =>\n"
            f"  Schema.Struct({{\n{fields}  }});\n"
        )

    def emit_api_method(self, method: ApiMethod) -> tuple[str, str]:
        """Emit the payload schema for one registry entry.

        Returns the method's PascalCase name and success schema expression (the
        client factory references the success schema statically per method).
        """
        class_name = _pascal(method.name)
        info = mi.type_info(method.request)
        if not isinstance(info, _StructLike):
            msg = f"api method {method.name!r} request must be struct-like"
            raise TypeError(msg)
        payload = self.fields_src(info, indent="  ")
        success = self.type_expr(mi.type_info(method.response))
        self.definitions.append(
            f"export const {class_name}Payload = Schema.Struct({{\n{payload}}});\n"
        )
        return class_name, success


_DISPATCH_HELPER = """\
type Execute<E, R> = (call: MarimoApiCall) => Effect.Effect<unknown, E, R>;

/**
 * Validate the outgoing params against the payload schema (the wire/Encoded
 * side, so defaulted fields stay omittable), send them verbatim, and parse
 * the response against the method's success schema.
 */
const dispatch = <PA, PI, PR, A, I, R2, E, R>(
  execute: Execute<E, R>,
  call: MarimoApiCall & { readonly params: PI },
  payload: Schema.Schema<PA, PI, PR>,
  success: Schema.Schema<A, I, R2>,
): Effect.Effect<A, E | ParseResult.ParseError, R | PR | R2> =>
  Effect.zipRight(
    Schema.decode(payload)(call.params),
    Effect.flatMap(
      execute(call),
      Schema.decodeUnknown(success),
    ),
  );
"""


def generate() -> str:
    emitter = Emitter()
    for name, t in CONCRETE:
        emitter.emit_named(name, t)
    for cls, parameterized in GENERIC:
        emitter.emit_generic(cls, parameterized)
    api = [emitter.emit_api_method(method) for method in API_METHODS]
    members = "\n".join(
        f"  | {{ readonly method: {_ts_string(method.name)}; "
        f"readonly params: typeof {class_name}Payload.Encoded }}"
        for (class_name, _), method in zip(api, API_METHODS, strict=True)
    )
    emitter.definitions.append(
        "/**\n"
        " * Every command accepted by the `marimo.api` transport.\n"
        " *\n"
        " * Generated from the `API_METHODS` registry in `src/marimo_lsp/api.py`,\n"
        " * which is also what the server dispatches and validates against.\n"
        " */\n"
        f"export type MarimoApiCall =\n{members};\n"
    )
    emitter.definitions.append(_DISPATCH_HELPER)
    methods = "\n".join(
        f"  {_camel(method.name)}: (\n"
        f"    params: typeof {class_name}Payload.Encoded,\n"
        f"  ) =>\n"
        f"    dispatch(\n"
        f"      execute,\n"
        f"      {{ method: {_ts_string(method.name)}, params }},\n"
        f"      {class_name}Payload,\n"
        f"      {success},\n"
        f"    ),"
        for (class_name, success), method in zip(api, API_METHODS, strict=True)
    )
    emitter.definitions.append(
        "/**\n"
        " * Typed `marimo.api` client surface: one method per registry entry.\n"
        " *\n"
        " * Each method encodes its payload, dispatches `{ method, params }` over\n"
        " * `execute`, and parses the response against the method's success schema —\n"
        " * both sides of the wire are earned, not asserted.\n"
        " */\n"
        "export const makeApiClient = <E, R>(execute: Execute<E, R>) => ({\n"
        f"{methods}\n"
        "});\n"
    )
    return HEADER + "\n" + "\n".join(emitter.definitions)


def _format(path: pathlib.Path) -> None:
    """Run the extension's formatter so output is byte-stable under `just fix-ts`."""
    extension = OUTPUT.parents[2]
    subprocess.run(  # noqa: S603
        ["pnpm", "exec", "vp", "fmt", str(path.relative_to(extension))],  # noqa: S607
        cwd=extension,
        check=True,
        capture_output=True,
    )


def main() -> int:
    source = generate()
    if "--check" in sys.argv[1:]:
        # Format a sibling temp copy (same dir, so formatter config applies)
        # and compare against the checked-in file.
        with tempfile.NamedTemporaryFile(
            mode="w", dir=OUTPUT.parent, suffix=".check.gen.ts", delete=False
        ) as f:
            tmp = pathlib.Path(f.name)
            f.write(source)
        try:
            _format(tmp)
            drifted = OUTPUT.read_text() != tmp.read_text()
        finally:
            tmp.unlink()
        if drifted:
            print(
                f"{OUTPUT} is out of date; run `just generate-schemas`", file=sys.stderr
            )
            return 1
        return 0
    OUTPUT.write_text(source)
    _format(OUTPUT)
    print(f"wrote {OUTPUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
