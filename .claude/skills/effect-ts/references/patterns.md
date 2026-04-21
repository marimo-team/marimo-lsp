# Patterns & Idioms

Common recipes and anti-patterns distilled from idiomatic Effect codebases.

## The service pattern — the core workflow

Effect development follows a service-driven workflow:

1. **Define the service interface** — what methods does it expose?
2. **Write business logic** that uses the service (via `yield*`)
3. **Implement the layer** — how is the service constructed?
4. **Wire at the edge** — provide all layers at the entry point

```ts
// 1. Define the interface:
class UserRepo extends Context.Tag("@app/UserRepo")<
  UserRepo,
  {
    readonly findById: (id: UserId) => Effect.Effect<User, NotFound>
    readonly save: (user: User) => Effect.Effect<void>
  }
>() {}

// 2. Business logic uses the service:
const registerUser = Effect.fn("registerUser")(function*(input: RegisterInput) {
  const user = yield* validateInput(input)
  const repo = yield* UserRepo
  yield* repo.save(user)
  return user
})

// 3. Implement the layer:
const UserRepoLive = Layer.effect(
  UserRepo,
  Effect.gen(function*() {
    const sql = yield* SqlClient
    return {
      findById: Effect.fn("UserRepo.findById")(function*(id) {
        const row = yield* sql`SELECT * FROM users WHERE id = ${id}`
        if (row.length === 0) return yield* new NotFound({ id })
        return row[0]
      }),
      save: Effect.fn("UserRepo.save")(function*(user) {
        yield* sql`INSERT INTO users ${sql.insert(user)}`
      })
    }
  })
)

// 4. Wire at the entry point:
const main = registerUser(input).pipe(
  Effect.provide(UserRepoLive.pipe(Layer.provide(SqlLive)))
)
```

## The "use" pattern — wrapping third-party libraries

When integrating Promise-based libraries, expose a `use` callback instead of the raw client:

```ts
class PrismaClient extends Context.Tag("@app/PrismaClient")<
  PrismaClient,
  {
    readonly use: <A>(
      fn: (client: PrismaClientType, signal: AbortSignal) => Promise<A>
    ) => Effect.Effect<A, PrismaError>
  }
>() {}

const PrismaLive = Layer.scoped(
  PrismaClient,
  Effect.gen(function*() {
    const client = new PrismaClientType()
    yield* Effect.addFinalizer(() => Effect.promise(() => client.$disconnect()))
    return {
      use: (fn) => Effect.tryPromise({
        try: (signal) => fn(client, signal),
        catch: (cause) => new PrismaError({ cause })
      })
    }
  })
)

// Usage:
const users = yield* prisma.use((client) => client.user.findMany())
```

This gives you: automatic error wrapping, AbortSignal for interruption support, and encapsulation of the underlying client.

## Config pattern

```ts
import { Config, ConfigProvider } from "effect"

// Read config values:
const port = yield* Config.number("PORT")
const apiKey = yield* Config.redacted("API_KEY") // prevents accidental logging

// Provide test config:
const testConfig = ConfigProvider.fromJson({ PORT: 3000, API_KEY: "test" })
program.pipe(Effect.provide(Layer.setConfigProvider(testConfig)))
```

For complex config, define a service:

```ts
class AppConfig extends Effect.Service<AppConfig>()("@app/Config", {
  effect: Effect.gen(function*() {
    return {
      port: yield* Config.number("PORT"),
      dbUrl: yield* Config.string("DATABASE_URL"),
      apiKey: yield* Config.redacted("API_KEY")
    }
  })
}) {}
```

## Naming conventions

- **Service identifiers**: `"@app/ServiceName"` — namespaced, globally unique
- **Layer properties**: `Default` (from `Effect.Service`), or `Live`/`Test` as static properties
- **Effect.fn names**: match the function name — `Effect.fn("processUser")`
- **Error tags**: match the class name — `Schema.TaggedError<NotFound>("NotFound")("NotFound", ...)`
- **Branded types**: descriptive noun — `Schema.brand("UserId")`, `Schema.brand("Email")`

## Anti-patterns to avoid

**1. Scattering `Effect.provide` throughout business logic**

Provide layers once at the entry point. Business logic should declare what it needs via `R`, not wire its own dependencies.

**2. Breaking layer memoization with function calls**

```ts
// BAD — each call creates a new layer reference, so it builds twice:
const a = serviceA.pipe(Layer.provide(makeDbLayer()))
const b = serviceB.pipe(Layer.provide(makeDbLayer()))

// GOOD — same reference, built once:
const db = makeDbLayer()
const a = serviceA.pipe(Layer.provide(db))
const b = serviceB.pipe(Layer.provide(db))
```

**3. Dependencies in service method signatures**

Service methods should have `R = never`. Dependencies are resolved when building the layer, not when calling methods:

```ts
// BAD — dependency leaks into every call site:
class UserRepo {
  findById: (id: string) => Effect.Effect<User, NotFound, Database>
}

// GOOD — dependency resolved at construction:
class UserRepo {
  findById: (id: string) => Effect.Effect<User, NotFound>
}
// Database is acquired in the Layer, not per-method
```

**4. Using `it.layer` when per-test isolation is needed**

`it.layer` shares one instance across all tests in a describe block. State leaks between tests. Prefer `Effect.provide` per test unless the resource is truly expensive to create.

**5. Forgetting `Effect.fn` for reusable functions**

`Effect.fn` adds tracing spans with the function name. Anonymous `Effect.gen` closures lose debugging context. Always name reusable effectful functions.

**6. Raw primitives instead of branded types**

Use `Schema.brand` for domain primitives. A `string` that represents a UserId should be typed differently from one that represents an OrderId.

**7. Using `Effect.gen` for simple single-effect transforms**

```ts
// Unnecessary ceremony:
Effect.gen(function*() {
  const result = yield* someEffect
  return result.map(transform)
})

// Just pipe:
someEffect.pipe(Effect.map(transform))
```

## Where to look for more patterns

- **effect-solutions** (`github.com/kitlangton/effect-solutions`) — curated idiomatic patterns with tests
- **effect-smol** (`github.com/Effect-TS/effect-smol`) — Effect v4 examples in `ai-docs/src/`
- **Effect docstrings** — `packages/effect/src/Effect.ts` has comprehensive examples in JSDoc
