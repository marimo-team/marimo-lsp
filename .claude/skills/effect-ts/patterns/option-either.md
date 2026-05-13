# Option & Either — patterns

## TL;DR

`Option<A>` models *absence as a normal outcome* — missing editor, unset config,
empty lookup. `Either<A, E>` models *one of two outcomes* with a typed failure
branch — synchronous parse/validate that doesn't need `R` or async. Both narrow
**at the use site**, which is the whole point: no `value!`, no `?? fallback`
buried three layers deep, no silent `undefined` propagation.

Project rule (`CLAUDE.md` "Prefer Schema or type guards"): treat `!`, `as T`,
and `as unknown as T` the way Rust treats `unsafe`. Reach for `Option` at every
nullable API boundary instead.

## Option vs Either — when to use which

| | When to reach for it | Constructor | Eliminator | Bridge from Effect |
|---|---|---|---|---|
| `Option<A>` | A value may simply be absent and absence is not an error (no `vscode.activeTextEditor`, no entry in a map, optional config key). | `Option.some` / `Option.none` / `Option.fromNullable` | `Option.match` / `Option.getOrElse` / `Option.isSome` | `Effect.option(self)` → `Effect<Option<A>, never, R>` (errors *swallowed*) |
| `Either<A, E>` | A synchronous step has a typed failure (parse, validate, throwing JS API) and you want the failure as data, not a thrown defect. | `Either.right` / `Either.left` / `Either.try({ try, catch })` | `Either.match` / `Either.getOrElse` / `Either.isLeft` | `Effect.either(self)` → `Effect<Either<A, E>, never, R>` (error *preserved*) |

Rule of thumb: if the call site cares *why* it failed, use `Either`/`Effect`;
if it only cares *whether* a value is there, use `Option`.

## Constructors & combinators

Citations are to `repos/effect/packages/effect/src/Option.ts` and `Either.ts`.

```ts
import { Either, Option } from "effect";

// --- Option ---
Option.some(1);                              // (:187)
Option.none<number>();                       // (:162)
Option.fromNullable(maybeUndef);             // T|null|undef -> Option<NonNullable<T>> (:684)
Option.fromIterable([1, 2, 3]);              // head of iterable, or None (:390)
Option.liftPredicate((n: number) => n > 0); // curried: (a) => Option<a> (:1805)

Option.isSome(opt); Option.isNone(opt);      // type guards (:258, :237)
Option.map / flatMap / flatten / filter;     // (:923, :1047, :1170, :1638)
Option.getOrElse(opt, () => fallback);       // (:500)
Option.match(opt, { onSome, onNone });       // (:299) — exhaustive
Option.orElse(opt, () => other);             // (:544)

// --- Either ---
Either.right(1); Either.left(new MyErr());                          // (:120, :138)
Either.fromNullable(x, () => new MyErr());                          // (:156)
Either.try({ try: () => JSON.parse(s), catch: (e) => new Err(e) }); // (:183)

Either.isLeft(e); Either.isRight(e);         // (:256, :273)
Either.mapLeft(e, (err) => newErr);          // (:350) — no Option analogue
Either.match(e, { onLeft, onRight });        // (:397)
Either.getOrElse(e, (err) => fallback);      // (:536)
```

## Effect ↔ Option/Either bridges

The asymmetry between `Effect.option` and `Effect.either` is **load-bearing**.

```ts
// Effect.option : Effect<A, E, R>  -> Effect<Option<A>, never, R>
//   E is DISCARDED. Use when you don't care WHY it failed, only IF.        (Effect.ts:8109)
const regs = yield* client.registrations
  .await("workspace/didChangeWatchedFiles")
  .pipe(Effect.timeout("10 seconds"), Effect.option);
// extension/src/lsp/connect.ts:135-137 — timeout? we just skip and move on.

// Effect.either : Effect<A, E, R>  -> Effect<Either<A, E>, never, R>
//   E is PRESERVED as Left. Use when the caller needs the typed error.    (Effect.ts:8180)
const result = yield* uv.syncScript({ script }).pipe(Effect.either);
if (Either.isLeft(result)) { /* result.left is fully typed */ }
```

And the two `fromNullable`s — same name, different layers:

```ts
// Pure: nullable -> Option<A>. No effect. No error channel. Use everywhere. (Option.ts:684)
Option.fromNullable(api.activeTextEditor);

// Effectful: nullable -> Effect<NonNullable<A>, NoSuchElementException>.   (Effect.ts:13242)
// Use ONLY when you want absence to become a failure in the Effect channel,
// e.g., to short-circuit a gen-flow with a typed missing-element error.
yield* Effect.fromNullable(maybeRow);

// Bridge an Option into an Effect failure with a custom error:
yield* Effect.fromOption(opt).pipe(Effect.mapError(() => new NotFoundError()));
// (`Effect.fromOption` fails with NoSuchElementException by default.)
```

If you find yourself doing `if (x == null) yield* Effect.fail(...)`, that's
`Effect.fromNullable` + `Effect.mapError`.

## Worked examples (from this repo)

**1. VS Code API boundary — wrap nullable once, hand consumers an `Option`.**
The `Code` service in `extension/src/platform/VsCode.ts` is the *only* place we
talk to nullable `vscode.*` APIs. Everywhere else gets `Option<T>`:

```ts
// extension/src/platform/VsCode.ts:79-83, 157-167
showSaveDialog(options?) {
  return Effect.map(
    Effect.promise(() => api.showSaveDialog(options)),
    Option.fromNullable,
  );
},
getActiveTextEditor() {
  return Effect.succeed(Option.fromNullable(api.activeTextEditor));
},
```

Consumers `match` or `getOrElse` — no `if (editor)` guards, no `editor!`
(`extension/src/panel/RecentNotebooks.ts:70-73` uses `Option.getOrElse(..., () => [])`).
Event streams compose the same way: `onDidChangeActiveTextEditor` emits
`Option.fromNullable(e)` into a `Stream` (`VsCode.ts:202-238`), so subscribers
never see `undefined`.

**2. Config keys are `Option`-shaped at the boundary** (`config/Config.ts:42-44`):

```ts
Option.fromNullable(config.get<string>("path")).pipe(
  Option.filter((p) => p.length > 0),  // empty string == not set
)
```

`filter` turns "present but empty" into `None` in one step — cleaner than
`x != null && x.length > 0`.

**3. Test-side `Effect.either` for asserting typed failures.** Canonical shape
in `python/__tests__/Uv.test.ts:64-68` and `EnvironmentValidator.test.ts:66-76`:

```ts
const result = yield* Effect.either(
  uv.addProject({ directory: tmpdir.path, packages: ["httpx"] }),
);
assert(Either.isLeft(result), "Expected failure");
assert.strictEqual(result.left._tag, "UvMissingPyProjectError");
```

After `Either.isLeft(result)`, TS narrows `result.left` to the exact tagged
error — no casts, no manual `_tag` checks before access.

**4. Best-effort effects with `Effect.option`** (`telemetry/HealthService.ts:88-96`):
fetching the Python env path shouldn't tank the whole health report — drop the
error, branch on presence: `yield* pyExt.getActiveEnvironmentPath().pipe(Effect.option)`.

## Worked examples (from Effect itself)

The bridge signatures *are* the contract — read the `never` slot:

- `Effect.option` (`Effect.ts:8109`): `Effect<A, E, R> -> Effect<Option<A>, never, R>` — `never` in E means failures cannot escape.
- `Effect.either` (`Effect.ts:8180`): `Effect<A, E, R> -> Effect<Either<A, E>, never, R>` — same `never`, but `E` lives on inside `Left`.
- `Either.fromNullable` (`Either.ts:156`) mirrors `Option.fromNullable` (`Option.ts:684`) with an extra `onNullable: () => E` — same shape as `Effect.fromOption` + `Effect.mapError`, but synchronous and `R`-free.

## Error handling

- Don't `try { ... } catch` around throwing JS. Use `Either.try({ try, catch })`
  inside a pure step, or `Effect.try`/`Effect.tryPromise` inside Effect.
- Inside `Effect.gen`, prefer `Effect.either`/`Effect.option` over manual
  `catchAll` *when the next line wants to branch on the outcome*. `catchAll` is
  for *recovery*; `either`/`option` is for *inspection*.
- `Option.match` and `Either.match` are exhaustive — TS will complain if you
  add a case and forget a branch. Use them at boundaries; use `isSome`/`isLeft`
  for short narrowing in flow.

## What to avoid

- **`x!` or `x as T` to silence "possibly undefined"** — wrap with
  `Option.fromNullable`. If you really know more than the compiler, leave a
  `// SAFETY:` comment (see `CLAUDE.md`).
- **`yield* effect` then `if (result == null)`** — the effect didn't produce
  `null`; you forgot to lift. Use `Effect.option` (or `Effect.either`).
- **`Effect.either` then ignoring `Left`** — that's `Effect.option` with extra
  steps. Pick the bridge that matches what you do next.
- **`Option.fromNullable(x).pipe(Option.getOrElse(() => x))`** — defeats the
  point; just keep `x`. Use `Option.match` *or* a real default.
- **Custom `Maybe<T>` / `Result<T, E>` types** — Effect already ships these,
  with the `Effect.option`/`Effect.either` bridges. A parallel hierarchy
  throws those away.
