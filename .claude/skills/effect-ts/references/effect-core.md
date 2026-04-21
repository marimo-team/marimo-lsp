# Effect Core

The `Effect<A, E, R>` type is a lazy description of a computation. Nothing runs until you explicitly execute it. This is what makes Effect composable — you build up a description of your program, then run it once at the edge.

## Effect.gen — the primary coding style

`Effect.gen` with `yield*` is how you write sequential Effect code. Think of it as `async/await` but with typed errors and dependency tracking:

```ts
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const user = yield* fetchUser(id)
  yield* Effect.log(`Found user: ${user.name}`)
  const orders = yield* fetchOrders(user.id)
  return { user, orders }
})
```

`yield*` unwraps an Effect the way `await` unwraps a Promise — but the compiler also tracks the errors and requirements of every yielded effect, unioning them into the final type.

## Effect.fn — named, traced functions

For reusable effectful functions, prefer `Effect.fn` over wrapping `Effect.gen` in a function. It creates a tracing span automatically and gives better stack traces:

```ts
const processUser = Effect.fn("processUser")(function*(userId: string) {
  const user = yield* fetchUser(userId)
  yield* Effect.log(`Processing ${user.name}`)
  return yield* saveUser(user)
})

// You can also apply cross-cutting concerns as additional arguments:
const fetchWithRetry = Effect.fn("fetchWithRetry")(
  function*(url: string) {
    return yield* httpGet(url)
  },
  Effect.retry({ times: 3 }),
  Effect.timeout("5 seconds")
)
```

## pipe — layering on behavior

`pipe` applies transformations left-to-right. Use it to add cross-cutting concerns without modifying the effect body:

```ts
const program = fetchData.pipe(
  Effect.timeout("5 seconds"),
  Effect.retry(Schedule.exponential("100 millis")),
  Effect.tap((data) => Effect.log(`Fetched ${data.length} items`)),
  Effect.withSpan("fetchData")
)
```

## Creating effects

| Constructor | Use when |
|-------------|----------|
| `Effect.succeed(value)` | You have a pure value |
| `Effect.fail(error)` | You have a typed error |
| `Effect.sync(() => ...)` | Synchronous side effect |
| `Effect.promise((signal) => ...)` | Wrapping a Promise (no typed error) |
| `Effect.tryPromise({ try, catch })` | Wrapping a Promise with error mapping |
| `Effect.async(resume => ...)` | Callback-based APIs |
| `Effect.gen(function*() { ... })` | Composing multiple effects |

## Running effects

Effects are descriptions — they don't execute until you run them:

```ts
// In a program entry point:
import { NodeRuntime } from "@effect/platform-node"
NodeRuntime.runMain(program) // handles signals, error reporting

// In tests or one-off scripts:
Effect.runPromise(program)   // returns Promise<A>, throws on failure
Effect.runSync(program)      // synchronous, throws if async
```

## Key combinators

- `Effect.map(f)` — transform the success value
- `Effect.flatMap(f)` — chain into another effect
- `Effect.tap(f)` — side-effect on success without changing the value
- `Effect.all([a, b, c])` — run effects concurrently, collect results
- `Effect.forEach(items, f)` — map over items effectfully
- `Effect.andThen(next)` — sequence two effects
- `Effect.provide(layer)` — satisfy requirements

## Where to look in the codebase

- **Public API**: `packages/effect/src/Effect.ts` — 470KB+ of exports and docstrings. The docstrings are comprehensive; read them for any combinator you're unsure about.
- **Core primitives**: `packages/effect/src/internal/core.ts` and `core-effect.ts` — the fundamental building blocks (`succeed`, `fail`, `flatMap`, `sync`, etc.)
- **Runtime engine**: `packages/effect/src/internal/fiberRuntime.ts` — how effects are actually executed. This is where the fiber scheduler, interruption handling, and stack-safe recursion live.
- **Effect.fn implementation**: search for `export const fn` in `Effect.ts` (~line 14630)
