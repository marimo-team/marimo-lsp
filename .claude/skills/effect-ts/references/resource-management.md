# Resource Management

Effect guarantees that resources are cleaned up, even when fibers are interrupted or errors occur. This is built on `Scope` — an abstraction that tracks finalizers and runs them when the scope closes.

## Scope — the lifecycle container

A `Scope` collects finalizers (cleanup functions) and runs them when it closes. You rarely create scopes manually — they're created by `Effect.scoped`, Layer construction, and fiber forking.

The key mental model: when you acquire a resource inside a scope, you register a finalizer. When the scope ends — whether by success, failure, or interruption — all finalizers run in reverse order.

## acquireRelease — the core pattern

```ts
import { Effect } from "effect"

const managedConnection = Effect.acquireRelease(
  // Acquire:
  Effect.tryPromise(() => pool.getConnection()),
  // Release (runs on scope close):
  (conn) => Effect.promise(() => conn.release())
)

// Use within a scope:
const program = Effect.scoped(
  Effect.gen(function*() {
    const conn = yield* managedConnection
    return yield* conn.query("SELECT * FROM users")
  })
)
// Connection is released when the scope exits
```

The release function runs regardless of how the scope ends — success, failure, or interruption. You can also inspect the exit value:

```ts
Effect.acquireRelease(
  acquire,
  (resource, exit) =>
    Exit.isFailure(exit)
      ? Effect.log("Cleaning up after failure")
      : Effect.log("Clean exit")
)
```

## addFinalizer — ad-hoc cleanup

When you don't have a distinct acquire/release pair, use `addFinalizer` to register cleanup:

```ts
const program = Effect.gen(function*() {
  const tmpDir = yield* createTempDir()
  yield* Effect.addFinalizer(() => removeTempDir(tmpDir))
  // tmpDir is cleaned up when the enclosing scope ends
  return yield* doWorkIn(tmpDir)
})
```

## ensuring — unconditional cleanup

`Effect.ensuring` runs a finalizer after the effect completes, regardless of outcome:

```ts
const program = doWork.pipe(
  Effect.ensuring(cleanup)
)
```

This is simpler than `acquireRelease` but doesn't give you access to the acquired resource.

## Scoped resources in Layers

Layers with resources use `Layer.scoped` — the resource lives as long as the layer's scope:

```ts
const DatabaseLive = Layer.scoped(
  Database,
  Effect.gen(function*() {
    const config = yield* AppConfig
    const pool = yield* Effect.acquireRelease(
      Effect.tryPromise(() => createPool(config.dbUrl)),
      (pool) => Effect.promise(() => pool.end())
    )
    return {
      query: (sql) => Effect.tryPromise(() => pool.query(sql)),
      execute: (sql) => Effect.tryPromise(() => pool.execute(sql))
    }
  })
)
```

The pool lives for the lifetime of the application (or test) and is properly closed when the layer is torn down.

## Nested scopes

Scopes nest naturally. Inner scopes finalize before outer scopes:

```ts
const program = Effect.scoped(
  Effect.gen(function*() {
    const outer = yield* acquireOuter
    const result = yield* Effect.scoped(
      Effect.gen(function*() {
        const inner = yield* acquireInner
        return yield* useResources(outer, inner)
      })
    )
    // inner is released here, outer is still alive
    return yield* moreWork(outer, result)
  })
)
// outer is released here
```

## Where to look in the codebase

- **Scope public API**: `packages/effect/src/Scope.ts` — Scope type, `addFinalizer`, `close`
- **acquireRelease**: search `Effect.ts` for `acquireRelease` — several variants (`acquireRelease`, `acquireUseRelease`)
- **Scope internals**: `packages/effect/src/internal/fiberScope.ts` — how scopes track and run finalizers
- **Layer.scoped**: `packages/effect/src/Layer.ts` — search for `scoped`
