# Error Handling

Effect distinguishes between two kinds of failures:

- **Expected errors** (`E`) — domain errors you model and handle. Tracked in the type system.
- **Defects** — unexpected crashes (bugs, null pointers, OOM). Not in the `E` type. Propagate as unrecoverable unless explicitly caught.

This distinction matters: you handle expected errors with combinators; defects kill the fiber unless intercepted.

## Defining domain errors

Use `Schema.TaggedError` for errors that need serialization (across network, logging, persistence). Use `Data.TaggedError` for lightweight internal errors.

```ts
import { Schema, Data } from "effect"

// Schema-based (serializable, schema-validated):
class NotFound extends Schema.TaggedError<NotFound>("NotFound")(
  "NotFound",
  { id: Schema.String }
) {}

// Data-based (lightweight, no schema overhead):
class Timeout extends Data.TaggedError("Timeout")<{
  readonly duration: number
}> {}
```

Both are yieldable — you can short-circuit an `Effect.gen` by yielding them directly:

```ts
const findUser = Effect.fn("findUser")(function*(id: string) {
  const user = yield* db.query(`SELECT * FROM users WHERE id = ?`, id)
  if (!user) {
    return yield* new NotFound({ id })  // short-circuits with typed error
  }
  return user
})
// findUser: (id: string) => Effect<User, NotFound, Database>
```

## Catching errors

```ts
// Catch a specific error by tag:
program.pipe(
  Effect.catchTag("NotFound", (err) =>
    Effect.succeed({ fallback: true, id: err.id })
  )
)

// Catch multiple tags at once:
program.pipe(
  Effect.catchTags({
    NotFound: (err) => Effect.succeed(null),
    Timeout: (err) => Effect.succeed(null),
  })
)

// Catch all expected errors:
program.pipe(
  Effect.catchAll((err) => Effect.succeed("recovered"))
)

// Catch based on a predicate:
program.pipe(
  Effect.catchIf(
    (err): err is NotFound => err._tag === "NotFound" && err.id === "admin",
    (err) => Effect.succeed(adminFallback)
  )
)
```

## Converting between error types

```ts
// Expected error -> defect (you're asserting it won't happen):
const config = yield* loadConfig.pipe(Effect.orDie)

// Defect -> expected error:
program.pipe(Effect.catchAllDefect((defect) => Effect.fail(new AppError({ cause: defect }))))

// Transform an error:
program.pipe(
  Effect.mapError((err) => new HigherLevelError({ cause: err }))
)
```

## Cause — the full failure picture

When an effect fails, the failure is wrapped in a `Cause` that captures everything that went wrong — including parallel failures, interruption, and defects:

```ts
program.pipe(
  Effect.catchAllCause((cause) => {
    // cause contains the full tree of failures
    const failures = Cause.failures(cause)  // just the E values
    const defects = Cause.defects(cause)    // just the unexpected throws
    return Effect.log(`Failed: ${Cause.pretty(cause)}`)
  })
)
```

## The error channel in practice

The type system tracks your error channel through composition:

```ts
const a: Effect<string, NotFound, never> = ...
const b: Effect<number, Timeout, never> = ...

const c = Effect.gen(function*() {
  const s = yield* a
  const n = yield* b
  return `${s}: ${n}`
})
// c: Effect<string, NotFound | Timeout, never>
//                   ^-- union of all yielded errors
```

When you `catchTag("NotFound", ...)`, it's *removed* from the error union. When all errors are handled, `E` becomes `never`.

## Where to look in the codebase

- **Cause type**: `packages/effect/src/Cause.ts` — `Fail`, `Die`, `Interrupt`, `Sequential`, `Parallel`, `Empty` variants, plus `pretty`, `failures`, `defects`
- **Exit type**: `packages/effect/src/Exit.ts` — `Exit<A, E> = Success<A> | Failure<Cause<E>>`
- **Cause internals**: `packages/effect/src/internal/cause.ts` — rendering, folding, matching
- **Error catching**: search `Effect.ts` for `catchTag`, `catchAll`, `catchAllCause`
- **Data.TaggedError**: `packages/effect/src/Data.ts` — `export const TaggedError`
- **Schema.TaggedError**: `packages/effect/src/Schema.ts` — `export const TaggedError`
