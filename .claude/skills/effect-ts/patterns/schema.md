# Schema — patterns

## TL;DR

Effect's `Schema` is the codebase's default tool for any value that crosses a process or wire boundary: LSP request/response payloads, VS Code `Memento` blobs, subprocess stdout, HTTP responses. A `Schema<A, I, R>` decodes an **encoded** input `I` (almost always `unknown` at the boundary) into a **decoded** type `A`, optionally with Effect requirements `R`. Reach for `Schema.decodeUnknown(...)` instead of `as T`, hand-rolled type guards, or "trust me" interfaces — once parsed, the type is *earned* and downstream code can trust it without further narrowing. This is the codebase's `unsafe` boundary (`CLAUDE.md`: "Prefer Schema or type guards over type assertions").

## Constructors & combinators

Cite `repos/effect/packages/effect/src/Schema.ts:<line>`.

**Primitives** — `Schema.String`, `Number`, `Boolean`, `BigInt`, `Symbol`, `Object`; refined: `Int`, `NonEmptyString`, `UUID`; nullish-ish: `Unknown`, `Any`, `Never`, `Void`, `Null`, `Undefined`; transforming: `NumberFromString`, `DateFromString`, `DateTimeUtc`, `BigDecimal`, `parseJson` (`:4845`). `Schema.Literal("a", "b")` returns a union (`:703`); `Schema.Enums(MyEnum)` (`:779`).

**Structural** — `Schema.Struct({...})` (`:2936`), `Array` / `NonEmptyArray` (`:1587, :1629`), `Tuple` + `optionalElement` (`:1551, :1395`), `Record({ key, value })` (`:3060`), `partial(struct)` / `partialWith` (`:3220, :3229`), `pick(...keys)` / `omit(...keys)` (`:3068, :3077`).

**Choice / nullability** — `Schema.Union(A, B)` (`:1292`, discriminator inferred from `_tag` when present); `NullOr` / `UndefinedOr` / `NullishOr` (`:1320, :1334, :1348`); `OptionFromNullishOr`.

**Refinement** — `S.pipe(Schema.filter((x) => ok), { message, identifier })` (`:3695`).

**Transformation** — `Schema.transform(from, to, { decode, encode })` for total mappings (`:3940`); `transformOrFail` for fallible ones (`:3831`) — `decode`/`encode` return `Effect<_, ParseResult.ParseIssue>` (or `Either` via `ParseResult.succeed`/`fail`). `Schema.compose(a, b)` pipelines two schemas.

```ts
const Age = Schema.Number.pipe(Schema.int(), Schema.positive());
const Tag = Schema.Literal("idle", "queued", "running");
```

## Encoded vs Type (I and A)

Every schema carries two types: **`Encoded` (`I`)** is the wire shape (what `decodeUnknown` accepts); **`Type` (`A`)** is what the rest of the program consumes. They differ whenever a transform is involved (`NumberFromString`, `parseJson`, `withDecodingDefault`, `Schema.Class`, brands).

```ts
const Cell = Schema.Struct({ name: Schema.String, count: Schema.NumberFromString });
type CellWire = typeof Cell.Encoded; // { readonly name: string; readonly count: string }
type Cell     = typeof Cell.Type;    // { readonly name: string; readonly count: number }

const decoded = Schema.decodeUnknownSync(Cell)({ name: "x", count: "3" }); // count: number
const wire    = Schema.encodeSync(Cell)(decoded);                          // count: string
```

The repo convention is `export const Foo = Schema.Struct({...}); export type Foo = typeof Foo.Type;` (`extension/src/schemas/CellMetadata.ts:55`, `SerializedNotebook.ts:44`). Don't hand-write a parallel `interface Foo {...}` — it drifts. `encode`/`encodeSync` go `A → I`; needed when writing back to the wire (e.g. saving cell metadata, `CellMetadata.ts:65`).

## Optional fields & decoding defaults

Three knobs on optional-ness, chosen by what the wire allows and what callers want to see:

| Pattern | Encoded (`I`) | Decoded (`A`) |
|---|---|---|
| `S.pipe(Schema.optional)` | `key?: T \| undefined` | `key?: T \| undefined` |
| `S.pipe(Schema.optionalWith({ nullable: true }))` | `key?: T \| null \| undefined` | `key?: T \| undefined` |
| `S.pipe(Schema.optionalWith({ exact: true }))` | `key?: T` (no `undefined`) | `key?: T` |
| `S.pipe(Schema.optionalWith({ as: "Option" }))` | `key?: T` | `Option<T>` |
| `S.pipe(Schema.optionalWith({ default: () => v }))` | `key?: T` | `T` (required) |
| `field.pipe(optionalWith({ nullable: true }), withDecodingDefault(() => v))` | `key?: T \| null \| undefined` | `T` (required) |

`Schema.ts:2542` (`optional`), `:2553` (`optionalWith`), `:2061` (`withDecodingDefault`). Tests cover the behavior matrix in `repos/effect/packages/effect/test/Schema/Schema/optionalWith.test.ts`.

This is the LSP-boundary workhorse: the marimo server returns nullables, callers want sensible defaults. `extension/src/schemas/SerializedNotebook.ts:13-30` uses `optionalWith({ nullable: true })` + `withDecodingDefault` so downstream code never branches on `null`:

```ts
const CellDef = Schema.Struct({
  code: Schema.String,
  name: Schema.String.pipe(
    Schema.optionalWith({ nullable: true }),
    Schema.withDecodingDefault(() => "_"),
  ),
  ...
});
```

`Schema.partial(struct)` makes every field optional in one shot — used for VS Code cell metadata in `CellMetadata.ts:27` where any subset may be present.

## Recursion, branding & classes

**Recursion** — TS can't infer self-referential `typeof`, so declare an `interface` first, then close the cycle with `Schema.suspend(() => Self)` (`:3572`). `extension/src/panel/packages/schemas.ts:17-32`:

```ts
export interface DependencyTreeNode {
  readonly name: string;
  readonly version: string | null;
  readonly dependencies: readonly DependencyTreeNode[];
}
export const DependencyTreeNode: Schema.Schema<DependencyTreeNode> = Schema.Struct({
  name: Schema.String,
  version: Schema.NullOr(Schema.String),
  dependencies: Schema.Array(Schema.suspend(() => DependencyTreeNode)),
});
```

For mutually recursive schemas, use `Schema.suspend((): Schema.Schema<Other> => Other)` inside each side (`repos/effect/packages/effect/test/Schema/Schema/suspend.test.ts:64-100`).

**Branding** — `S.pipe(Schema.brand("Foo"))` adds a nominal `Brand<"Foo">`. `Schema.fromBrand(brandCtor)` (`:1113`) pairs an existing `Brand.nominal<T>()` with a base schema — used for `NotebookIdFromString` in `extension/src/schemas/MarimoNotebookDocument.ts:34`:

```ts
export type NotebookId = Brand.Branded<string, "NotebookId">;
const NotebookId = Brand.nominal<NotebookId>();
export const NotebookIdFromString = Schema.String.pipe(Schema.fromBrand(NotebookId));
```

In hot paths prefer reading already-branded values (e.g. `document.id`); the schema is for raw inputs.

**Classes** — `class Foo extends Schema.Class<Foo>("Foo")({ fields })` (`:8504`) produces a real JS class with the field shape, a `make(...)` constructor, and method retention. `TaggedClass` (`:8771`) adds `_tag`. `TaggedError` (`:8834`) extends `Data.Error` so you can `yield* new E({...})`. `extension/src/python/Uv.ts:589`:

```ts
class VersionInfo extends Schema.Class<VersionInfo>("VersionInfo")({
  package_name: Schema.String,
  version: Schema.String,
  commit_info: Schema.NullOr(Schema.Struct({ /* … */ })),
}) {
  format() { return this.commit_info ? `${this.version} (${this.commit_info.short_commit_hash})` : this.version; }
}
```

## Decoding at boundaries (`decodeUnknown` / `Option` / `Either` + `ParseError`)

Pick the variant whose return type matches the call-site's error story:

```ts
// Effect-returning — DEFAULT at boundaries. Error flows through E.
const value: A = yield* Schema.decodeUnknown(MySchema)(raw); // ParseError in E channel

// Either — no Effect runtime; pure helpers, tests
const result = Schema.decodeUnknownEither(MySchema)(raw);    // Either<A, ParseError>

// Option — lossy. Discards the parse error.
const maybe = Schema.decodeUnknownOption(MySchema)(raw);     // Option<A>

// Sync — THROWS. Only for tests, fixtures, module-level constants.
const value = Schema.decodeUnknownSync(MySchema)(raw);
```

`Schema.ts:561` (`decodeUnknown`), `:574` (`decodeUnknownEither`), `:587` (`decodeUnknownPromise`). `decodeUnknown` takes `unknown` (the boundary); `decode` takes the typed encoded `I` (already-validated input).

The repo convention: **`decodeUnknown` at boundaries** so `ParseError` flows through the typed error channel. `Option` is only appropriate when "I will substitute a default on parse failure" is the right semantic (`CellMetadata.ts:60` uses `decodeUnknownOption` because every cell metadata field is optional anyway, and a parse miss falls back to `Option.none()` which `MarimoNotebookCell` treats as "no metadata").

Map the parse error into a domain `Data.TaggedError` so callers don't depend on `ParseResult` internals (`extension/src/platform/Storage.ts:74`):

```ts
const decoded = yield* Schema.decodeUnknown(storageKey.schema)(raw).pipe(
  Effect.mapError((cause) => new StorageDecodeError({ cause })),
);
```

Inside `transformOrFail`, build issues directly (`extension/src/schemas/SemVerFromString.ts`):

```ts
return ParseResult.fail(
  new ParseResult.Type(Schema.String.ast, from, `Invalid semver: ${from}`),
);
```

`ParseIssue` constructors (`Type`, `Missing`, `Unexpected`, `Refinement`, `Transformation`, `Composite`, `Pointer`) live in `repos/effect/packages/effect/src/ParseResult.ts:29-210`. For ad-hoc failures, `new ParseResult.Type(ast, actual, message?)` is almost always right.

## Worked examples (from this repo)

**LSP wire boundary** — `extension/src/notebook/NotebookSerializer.ts:250`:

```ts
const decodeDeserializeResponse = Schema.decodeUnknown(SerializedNotebook);
const decodeSerializeResponse = Schema.decodeUnknown(Schema.Struct({ source: Schema.String }));
const notebook = yield* decodeDeserializeResponse(lspResponse);
```

**Subprocess stdout → typed value in one step** — `extension/src/python/Uv.ts:611-615` composes `parseJson` with a class schema:

```ts
Command.string,
Effect.map(Schema.decodeOption(Schema.parseJson(VersionInfo))),
```

**Type-safe `Memento` storage** — `extension/src/platform/Storage.ts:40`. `createStorageKey(key, schema)` binds a key to a schema; `.get()` returns `Effect<Option<A>, StorageDecodeError>`, `.set()` encodes via the same schema. Concrete use in `extension/src/panel/RecentNotebooks.ts:25`.

## Worked examples (from Effect itself)

**`Schema.parseJson(inner)`** (`Schema.ts:4845`) — composes `string → JSON → inner`. Used in `extension/src/python/EnvironmentValidator.ts:104` to parse a subprocess's JSON stdout into a typed schema in one decode.

**Mutually recursive schemas** (`test/Schema/Schema/suspend.test.ts:64`) — declare two `interface`s, then `Schema.suspend((): Schema.Schema<Other> => Other)` inside each `Struct` to close the cycle. Decoding paths report `<suspended schema>` markers in error messages but parse identically.

**`optionalWith({ as: "Option" })`** (`test/Schema/Schema/optionalWith.test.ts:135-155`) — encoded form is `key?: T`, decoded form is `Option<T>`. Crisper at use-site than nullable + manual `Option.fromNullable`.

## Error handling

A failed decode yields `ParseResult.ParseError` (`ParseResult.ts:230`, a `Data.TaggedError`). Two formatters:

- `ParseResult.TreeFormatter.formatErrorSync(error)` — ASCII tree, human-readable; what `error.toString()` returns (`ParseResult.ts:1747`).
- `ParseResult.ArrayFormatter.formatErrorSync(error)` — `Array<{ _tag, path, message }>`, machine-readable for diagnostics (`ParseResult.ts:1970`).

`ParseError` extends `Data.TaggedError("ParseError")`, so `Effect.catchTag("ParseError", ...)` and `Effect.mapError` both work without unwrapping.

## What to avoid

**Don't** hand-roll `as T` / `as unknown as T` for data off the wire or out of `Memento`. The compiler can't check it; the kernel can't either; the error surfaces three modules later as `undefined.foo`. Define a `Schema` and `decodeUnknown` it at the boundary. If you must assert (e.g. a phantom-typed brand with no runtime representation, `Storage.ts:48`), leave a `// SAFETY:` comment stating the invariant — same convention Rust uses for `unsafe`.

**Don't** use `Schema.decodeUnknownSync` in production paths — it throws across an unrelated stack. Use `decodeUnknown` so the error flows through `E`. Sync is fine in tests, fixtures, and module-scope constants.

**Don't** declare a `Schema` *and* a parallel `interface` for the same shape — derive: `export type Foo = typeof Foo.Type;` (and `typeof Foo.Encoded` for the wire shape). They drift the moment one is edited.

**Don't** widen with `as unknown as Schema.Schema<MoreSpecific>` to satisfy a callsite — narrow the callsite or refine the schema. `extension/src/config/schemas.ts:10-13` does this with `// SAFETY:` + `TODO` because the upstream `MarimoConfig` shape is genuinely unstable; that's the bar — a real invariant being staked.

**Don't** `decodeUnknownOption(...)` and silently drop the `none` case — either fall back to a documented default (`Option.getOrElse(() => default)`) or log + recover. A swallowed parse failure is the same bug as `as T`, one indirection deeper.

**Don't** mock a schema-using service with `{} as FooService` in tests — fully `implements` the interface under `extension/src/__mocks__/Test*.ts`. If the schema's decoded type is hard to construct, that's a signal the schema isn't carrying enough structure, not that the test needs an escape hatch.
