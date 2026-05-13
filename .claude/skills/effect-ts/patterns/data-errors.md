# Data, Cause, Exit — typed-error patterns

## TL;DR

`Effect<A, E, R>` lifts every recoverable failure into `E`. `Data.TaggedError` is how this repo
*defines* those `E` types: a class with a `_tag` discriminator, structural equality, `yield*`-able
in a generator. Underneath, Effect stores the full failure tree in `Cause<E>` (typed fails +
defects + interrupts + sequential/parallel); `Exit<A, E>` is the terminal state of a fiber
(`Success<A>` or `Failure<E>` carrying a `Cause<E>`). Day-to-day: thread `E`, narrow with
`Effect.catchTag`. At boundaries that erase `E` (logging, telemetry, top-level command handlers),
use `Cause`/`Exit`.

## Constructors & combinators

```ts
import { Data } from "effect";

class FooErr  extends Data.TaggedError("FooErr")<{ msg: string }> {}    // canonical domain error; _tag, YieldableError
class BareErr extends Data.Error<{ msg: string }> {}                    // un-tagged YieldableError; rare
class Person  extends Data.Class<{ name: string }> {}                   // structurally-equal class, no _tag
class Cat     extends Data.TaggedClass("Cat")<{ name: string }> {}      // structurally-equal class with _tag (mocks, state-machine handles)
const alice   = Data.struct({ name: "Alice", age: 30 });                // ad-hoc struct with structural Equal
const xs      = Data.array([alice]);                                    // array with structural Equal
```

Why `Data.*`: values built with these have **structural equality** via `Equal.equals` — two
`new FooErr({ msg: "x" })` compare equal, which matters for `HashSet`/`HashMap`, dedup, and
snapshot tests. `class Foo extends Error` gives referential equality only. `Data.TaggedError`
instances are `YieldableError`, so `yield* new FooErr({...})` works without `Effect.fail`.

**Local convention — instance helpers.** Hang formatters on the tagged error itself instead of
spreading the logic across call sites. See `LanguageServerInstallError.format()` at
`extension/src/python/Uv.ts:161` — walks `this.attempts` and returns the multi-line UI string.

## Worked examples (from this repo)

**1. Tagged error with rich fields + a `refine` constructor** (see §5):

```ts
// extension/src/python/Uv.ts:80
class UvMissingPep723MetadataError extends Data.TaggedError(
  "UvMissingPep723MetadataError",
)<{ script: string; cause: UvUnknownError }> {
  static refine(script: string, cause: UvUnknownError) {
    return Effect.fail(
      cause.stderr.includes("does not contain a PEP 723 metadata")
        ? new UvMissingPep723MetadataError({ script, cause })
        : cause, // re-fail with the original UvUnknownError unchanged
    );
  }
}
```

**2. `catchTag` chain that peels off one tag at a time.** Each handler removes that tag from `E`;
the next `catchTag` is statically checked against the narrowed channel:

```ts
// extension/src/python/Uv.ts:229
return uv({ args: ["tree", "--script", options.script, "-d", "0", "--quiet"] }).pipe(
  Effect.catchTag("UvUnknownError", UvResolutionError.refine.bind(null)),
  Effect.catchTag(
    "UvUnknownError",
    UvMissingPep723MetadataError.refine.bind(null, options.script),
  ),
  Effect.map((e) => e.stdout),
);
```

**3. `catchTags` + `catchAllCause` as a terminal funnel.** Handle known cases by tag, route
everything else (typed leftovers + defects + interrupts) to a generic UI:

```ts
// extension/src/commands/debugCell.ts:41
flow(
  Effect.tapErrorCause(Effect.logError),
  Effect.catchTags({
    DebugSessionStartError: () =>
      showErrorAndPromptLogs("Failed to start debug session. Is the kernel running?"),
  }),
  Effect.catchAllCause(() => showErrorAndPromptLogs("Failed to debug cell.")),
);
```

## Worked examples (from Effect itself)

```ts
// Terminal handling — branch on the Exit, not on a thrown error
const exit = await Effect.runPromiseExit(program);
Exit.match(exit, {
  onSuccess: (a) => console.log("ok", a),
  onFailure: (cause) => console.error(Cause.pretty(cause, { renderErrorCause: true })),
});

// Cause.match — render every branch separately for telemetry/logs
Cause.match(cause, {
  onEmpty: () => "(empty)",
  onFail: (e) => `expected: ${String(e)}`,
  onDie: (d) => `defect: ${String(d)}`,
  onInterrupt: (id) => `interrupted: ${id}`,
  onSequential: (l, r) => `${l} then ${r}`, onParallel: (l, r) => `${l} & ${r}`,
});
```

## Refining errors with `static refine`

Many uv invocations fail with the same generic `UvUnknownError` (exit code + stderr). Downstream
callers want *specific* tags like `UvResolutionError` so they can `catchTag` precisely. The
convention: each refined subtype defines

```ts
static refine(...ctorArgs, cause: UvUnknownError): Effect<never, ThisError | UvUnknownError>
```

that sniffs `cause.stderr` and either fails with the refined subtype or re-fails with the
original `UvUnknownError`. Defined at `extension/src/python/Uv.ts:63-105` for three subtypes
(`UvMissingPyProjectError`, `UvMissingPep723MetadataError`, `UvResolutionError`), consumed at
8+ call sites:

```ts
// extension/src/python/Uv.ts:309 — chained refinements
return uv({ args }).pipe(
  Effect.catchTag("UvUnknownError", UvResolutionError.refine.bind(null)),
  Effect.catchTag(
    "UvUnknownError",
    UvMissingPyProjectError.refine.bind(null, options.directory),
  ),
  Effect.andThen(Effect.void),
);
```

Why this composes: each `refine` returns `Effect.fail(...)` whose channel is *either* the refined
tag or the original `UvUnknownError`. The first `catchTag("UvUnknownError", ...)` produces
`UvResolutionError | UvUnknownError` (un-matched cases fall through); the second peels off the
rest. End channel: `UvResolutionError | UvMissingPyProjectError`. No `as`, no manual narrowing —
the static method's return type carries the union forward.

## Bridging `Exit` to `Cause`

To go from "an `Effect` I ran" to "the `Cause` toolkit," cross through `Exit`:

```ts
const exit = await Effect.runPromiseExit(eff);   // Exit<A, E>
// or yield* Effect.exit(eff); or a fiber's exit from Runtime.runFork(...)

if (Exit.isFailure(exit)) { const cause = exit.cause; /* Cause<E> */ }
Exit.match(exit, { onSuccess: (a) => ..., onFailure: (cause) => ... /* Cause<E> */ });
Exit.causeOption(exit);                          // Option<Cause<E>> — None on success
```

Real use at `extension/src/lsp/RuffLanguageServer.ts:106` — `Effect.exit(...)` then branch on
`Exit.isSuccess` and stash `exit.cause` in a status `Ref`. `Scope.close(scope, Exit.void)` is the
inverse: synthetic successful `Exit` to tear down a scope that isn't itself an error.

## Inspecting `Cause` after `catchAllCause`

Inside `catchAllCause`, or anywhere typed `E` has been erased (a `Ref<Status>` that had to forget
its parameter, logger fields, telemetry extras), the failure type is `Cause<unknown>`. The
`Cause.*` API is what you reach for:

```ts
Cause.failures(cause)         // Chunk<E> — all typed failures (use with instanceof to narrow back)
Cause.failureOption(cause)    // Option<E> — first typed failure
Cause.isFailure(cause)        // contains a Fail anywhere
Cause.isDie(cause)            // defect-only
Cause.isInterruptedOnly(cause)// interruption-only (cancellation; not a user-visible error)
Cause.defects(cause)          // Chunk<unknown> — all defects
Cause.pretty(cause, { renderErrorCause: true })  // human-readable; what to log
Cause.isCause(value)          // refinement for logger-annotation walking
Cause.isEmpty(cause)
```

Real sites:

- `extension/src/lib/installPackages.ts:154` — `Cause.failures` → `instanceof UvUnknownError` →
  read `stderr` for user-facing detail.
- `extension/src/notebook/NotebookSerializer.ts:264` — `Cause.failureOption`, fall back to
  `Cause.isDie` / `Cause.isInterruptedOnly` to tag `"Die"` / `"Interrupt"` / `"Empty"`.
- `extension/src/platform/VsCode.ts:329-336` — skip notification when
  `Cause.isInterruptedOnly(cause)` or any `Cause.defects(cause)` is a VS Code `Canceled`.
- `extension/src/features/Logger.ts:28-31`, `extension/src/telemetry/Sentry.ts:175-184` — both
  use `Cause.isCause` then `Cause.pretty(value, { renderErrorCause: true })`.

## Error handling

Effect's catch combinators narrow `E` by `_tag`:

```ts
Effect.catchTag("FooErr", (e) => recoverFromFoo(e))            // single tag; E now excludes "FooErr"
Effect.catchTags({ FooErr: handleFoo, BarErr: handleBar })     // multiple at once
Effect.catchAll((e) => fallback(e))                            // catch all typed E (not defects/interrupts)
Effect.catchAllCause((cause) => ...)                           // catch typed + defects + interrupts
Effect.tapErrorCause(Effect.logError)                          // observe-and-rethrow at any boundary
Effect.either(eff)   // Effect<Either<A, E>, never, R>
Effect.exit(eff)     // Effect<Exit<A, E>, never, R>
```

Handle each tag explicitly with `catchTag`/`catchTags`; let the remaining `E` surface anything
you forgot. `catchAllCause` is a *terminal* funnel — see the `debugCell.ts` example above.

## What to avoid

- **`throw new Error(...)` inside `Effect.gen`** — becomes a `Die`, not a typed failure;
  `catchTag` can't see it. Do `yield* new FooErr({...})`.
- **`class Foo extends Error` for domain errors** — no `_tag`, no structural equality, no
  `yield*`. Use `Data.TaggedError("Foo")<{...}>`.
- **`e as Error` / `e as FooErr` in a `catch`** — `unknown` is `unknown` for a reason. Narrow
  with `instanceof`, use `Effect.try({ try, catch })` / `Effect.tryPromise({ try, catch })`, or
  walk the `Cause` (`Cause.failures` → `instanceof`). See `CLAUDE.md` "Prefer Schema or type
  guards over type assertions" — assertions need a `// SAFETY:` comment.
- **`Effect.catchAll` when you mean `catchTag`** — collapses every typed error into one handler
  and discards per-tag information. Reach for `catchAll`/`catchAllCause` only at terminal
  boundaries.
- **Forgetting `Cause.isInterruptedOnly` at user-facing boundaries** — a cancelled progress
  dialog isn't a failure the user caused. Filter before notifying (`VsCode.ts:329-336`).
- **Passing `Cause` through normal business logic** — thread `E`. `Cause` is for logging,
  telemetry, and serialization boundaries only.

> Out of scope: `Data.taggedEnum` for *non-error* discriminated unions — `UvBin`
> (`extension/src/python/Uv.ts:18`), `BinarySource`, LSP status enums — lives in the state /
> domain-modelling pattern doc.
