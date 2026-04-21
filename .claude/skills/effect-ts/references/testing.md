# Testing

Effect provides `@effect/vitest` for testing effectful code. The core idea: tests are effects too. You get the same typed errors, dependency injection, and resource management inside your tests.

## Setup

```ts
// vitest.setup.ts
import { addEqualityTesters } from "@effect/vitest"
addEqualityTesters() // enables Effect's structural equality in vitest matchers
```

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config"
export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"]
  }
})
```

## Writing effect tests

```ts
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

describe("UserService", () => {
  // Test with the simulated clock (default):
  it.effect("creates a user", () =>
    Effect.gen(function*() {
      const user = yield* createUser({ name: "Alice" })
      expect(user.name).toBe("Alice")
    })
  )

  // Test with the real clock (for actual timing):
  it.live("measures real latency", () =>
    Effect.gen(function*() {
      const start = yield* Clock.currentTimeMillis
      yield* Effect.sleep("100 millis")
      const elapsed = (yield* Clock.currentTimeMillis) - start
      expect(elapsed).toBeGreaterThanOrEqual(90)
    })
  )
})
```

## Providing test dependencies

The idiomatic pattern: define `testLayer` implementations using `Layer.sync` or `Layer.succeed`, then `Effect.provide` them in each test:

```ts
// In-memory implementation:
const TestDatabase = Layer.sync(Database, () => {
  const store = new Map<string, User>()
  return {
    query: (sql) => Effect.succeed([...store.values()]),
    save: (user) => Effect.sync(() => { store.set(user.id, user) })
  }
})

it.effect("saves and retrieves", () =>
  Effect.gen(function*() {
    const db = yield* Database
    yield* db.save({ id: "1", name: "Alice" })
    const users = yield* db.query("SELECT *")
    expect(users).toHaveLength(1)
  }).pipe(Effect.provide(TestDatabase))
)
```

## Composing test layers with provideMerge

Use `Layer.provideMerge` (not `Layer.provide`) when you need access to leaf services in your test for setup and assertions:

```ts
const TestStack = UserService.Default.pipe(
  Layer.provideMerge(TestDatabase),  // Database is still accessible
  Layer.provideMerge(TestConfig)
)

it.effect("user service calls database", () =>
  Effect.gen(function*() {
    // Can access both UserService AND the underlying Database:
    const db = yield* Database
    yield* db.save({ id: "1", name: "Alice" })

    const userService = yield* UserService
    const user = yield* userService.findById("1")
    expect(user.name).toBe("Alice")
  }).pipe(Effect.provide(TestStack))
)
```

## TestClock — controlling time

The test clock starts frozen. Advance it explicitly to trigger timeouts, delays, and schedules:

```ts
import { Effect, Fiber, TestClock } from "effect"

it.effect("retries with exponential backoff", () =>
  Effect.gen(function*() {
    let attempts = 0
    const task = Effect.gen(function*() {
      attempts++
      if (attempts < 3) {
        return yield* Effect.fail("not yet")
      }
      return "done"
    })

    const fiber = yield* task.pipe(
      Effect.retry(Schedule.exponential("1 second")),
      Effect.fork
    )

    // Advance time to trigger retries:
    yield* TestClock.adjust("1 second")  // first retry
    yield* TestClock.adjust("2 seconds") // second retry (exponential)

    const result = yield* Fiber.join(fiber)
    expect(result).toBe("done")
    expect(attempts).toBe(3)
  })
)
```

## withTestCtx — test context factory

When a test suite needs a complex layer stack *and* access to test doubles for arrangement/assertion, extract both into an effectful factory:

```ts
const withTestCtx = Effect.fn(function*(
  options: { initialUsers?: Array<User> } = {}
) {
  const testDb = yield* TestDatabase.make(options.initialUsers ?? [])
  return {
    db: testDb,                        // test double for arrangement/assertion
    layer: Layer.empty.pipe(
      Layer.merge(UserService.Default),
      Layer.provideMerge(testDb.layer),
      Layer.provide(TestConfigLive),
      Layer.provide(TestLoggerLive),
    ),
  }
})

it.scoped("notifies on user creation", Effect.fn(function*() {
  const ctx = yield* withTestCtx()

  yield* Effect.gen(function*() {
    const users = yield* UserService
    yield* users.create({ name: "Alice" })
  }).pipe(Effect.provide(ctx.layer))

  // Assert against the test double directly:
  expect(ctx.db.saved).toHaveLength(1)
}))
```

This pattern hits a sweet spot between inline layers (repetitive) and `it.layer` (shared/leaky):
- Each test gets a **fresh** context — no state leaks
- The factory is **effectful** (`Effect.fn`), so it can do async setup and gets tracing for free
- You get the composed **layer** for `Effect.provide` and direct handles to **test doubles** for assertions — in one call
- Options let tests customize setup (seed data, feature flags) without rewriting the stack

## it.layer — shared expensive resources

When a resource is expensive to create (database connection, server), share it across a `describe` block:

```ts
describe.concurrent("with shared database", () => {
  it.layer(ExpensiveDatabaseLayer)((it) => {
    it.effect("test 1", () => Effect.gen(function*() { ... }))
    it.effect("test 2", () => Effect.gen(function*() { ... }))
  })
})
```

Use `it.layer` sparingly — state leaks between tests. Prefer per-test `Effect.provide` for isolation.

## Where to look in the codebase

- **@effect/vitest**: `packages/vitest/src/` — `it.effect`, `it.live`, `it.layer`, equality testers
- **TestClock**: `packages/effect/src/TestClock.ts` and `internal/testing/testClock.ts`
- **TestContext**: `packages/effect/src/TestContext.ts` — bundles test services
