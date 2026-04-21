# Services & Layers

Effect's dependency injection system makes dependencies explicit in the type system. Instead of importing singletons or using a DI container, you declare what a computation *needs* (via `R`) and satisfy those needs with `Layer`.

## Defining a service

A service is a typed contract with a unique identifier. Use `Context.Tag` for the basic pattern:

```ts
import { Context, Effect, Layer } from "effect"

class Database extends Context.Tag("@app/Database")<
  Database,
  {
    readonly query: (sql: string) => Effect.Effect<unknown[]>
    readonly execute: (sql: string) => Effect.Effect<void>
  }
>() {}
```

The string `"@app/Database"` must be globally unique. The second type parameter defines the service's interface.

To access a service in an Effect:

```ts
const program = Effect.gen(function*() {
  const db = yield* Database         // pulls Database from the R context
  const rows = yield* db.query("SELECT * FROM users")
  return rows
})
// program: Effect<unknown[], never, Database>
//                                     ^-- requires Database
```

## Effect.Tag — service with proxy accessors

`Effect.Tag` extends `Context.Tag` with proxy methods, so you can call service methods directly on the tag:

```ts
class Notifications extends Effect.Tag("@app/Notifications")<
  Notifications,
  { readonly notify: (msg: string) => Effect.Effect<void> }
>() {}

// Instead of: yield* Notifications, then call .notify(...)
// You can do:
const program = Notifications.notify("hello") // Effect<void, never, Notifications>
```

## Effect.Service — service + layer in one

For services where implementation and definition are co-located:

```ts
class Prefix extends Effect.Service<Prefix>()("@app/Prefix", {
  succeed: { prefix: "PRE" }
}) {}

class Logger extends Effect.Service<Logger>()("@app/Logger", {
  effect: Effect.gen(function*() {
    const { prefix } = yield* Prefix
    return {
      info: (msg: string) => Effect.log(`[${prefix}] ${msg}`)
    }
  }),
  dependencies: [Prefix.Default]
}) {}
```

This creates both the tag and a `Logger.Default` layer automatically.

## Building layers

Layers describe how to construct services. They are memoized by default — a layer is only built once even if multiple services depend on it.

```ts
// From an effect (async, can use other services):
const DatabaseLive = Layer.effect(
  Database,
  Effect.gen(function*() {
    const config = yield* AppConfig
    const pool = yield* createPool(config.dbUrl)
    yield* Effect.addFinalizer(() => Effect.promise(() => pool.end()))
    return {
      query: (sql) => Effect.tryPromise(() => pool.query(sql)),
      execute: (sql) => Effect.tryPromise(() => pool.execute(sql))
    }
  })
)

// From a synchronous value (no dependencies):
const ConfigTest = Layer.succeed(AppConfig, { dbUrl: "sqlite::memory:" })

// From a sync function:
const InMemoryDb = Layer.sync(Database, () => {
  const store = new Map()
  return {
    query: (sql) => Effect.succeed([...store.values()]),
    execute: (sql) => Effect.sync(() => { store.set(sql, true) })
  }
})
```

## Composing layers

```ts
// provide: satisfy a layer's dependencies
const DbWithConfig = DatabaseLive.pipe(Layer.provide(ConfigLive))

// merge: combine independent layers
const AllServices = Layer.merge(DatabaseLive, LoggerLive)

// provideMerge: provide AND keep the provider in the output
// (useful in tests — you can access both the service AND its dependencies)
const TestStack = ServiceLive.pipe(
  Layer.provideMerge(InMemoryDb),
  Layer.provideMerge(ConfigTest)
)
```

## Provide once at the entry point

Wire everything at the edge of your program. Business logic should never call `Effect.provide`:

```ts
// main.ts
const AppLive = Layer.mergeAll(DatabaseLive, LoggerLive, AuthLive).pipe(
  Layer.provide(ConfigLive)
)

const main = program.pipe(Effect.provide(AppLive))
NodeRuntime.runMain(main)
```

## Layer memoization

Layers are memoized by reference. If two consumers depend on the same `Layer` *reference*, it's built once:

```ts
// GOOD — same reference, built once:
const shared = DatabaseLive
const a = ServiceA.pipe(Layer.provide(shared))
const b = ServiceB.pipe(Layer.provide(shared))

// BAD — different references from a function call, built twice:
const a = ServiceA.pipe(Layer.provide(makeDatabaseLayer()))
const b = ServiceB.pipe(Layer.provide(makeDatabaseLayer()))
```

## Where to look in the codebase

- **Layer public API**: `packages/effect/src/Layer.ts` — constructors, combinators, docstrings
- **Context/Tag**: `packages/effect/src/Context.ts` — Tag class, context manipulation
- **Layer internals**: `packages/effect/src/internal/layer/` — memoization, circular dependency handling
- **Effect.Tag/Service**: search `Effect.ts` for `export const Tag` (~line 13505) and `export const Service` (~line 13585)
