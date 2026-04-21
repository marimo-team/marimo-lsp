# Concurrency

Effect provides structured concurrency through fibers (lightweight green threads) and a set of coordination primitives. Concurrency in Effect is *structured*: fibers form parent-child trees, interruption propagates down, and resources are cleaned up automatically.

## Fiber — lightweight execution

A Fiber is a running Effect. Forking creates a child fiber; the parent can join, interrupt, or observe it:

```ts
import { Effect, Fiber } from "effect"

const program = Effect.gen(function*() {
  // Fork a child fiber (interrupted when parent completes):
  const fiber = yield* Effect.fork(longRunningTask)

  // Do other work concurrently...
  yield* doSomethingElse

  // Wait for the fiber to finish:
  const result = yield* Fiber.join(fiber)
  return result
})
```

Fork variants:
- `Effect.fork(effect)` — child fiber, interrupted when parent scope ends
- `Effect.forkDaemon(effect)` — detached, runs independently of parent
- `Effect.forkScoped(effect)` — tied to the current Scope
- `Effect.forkIn(effect, scope)` — tied to a specific Scope

## Deferred — one-time async variable

A `Deferred<A, E>` is a variable that starts empty and can be set exactly once. Fibers that `await` it suspend until it's set:

```ts
import { Deferred, Effect } from "effect"

const program = Effect.gen(function*() {
  const deferred = yield* Deferred.make<string, never>()

  // Consumer suspends until value is available:
  const consumer = yield* Effect.fork(
    Effect.gen(function*() {
      const value = yield* Deferred.await(deferred)
      yield* Effect.log(`Got: ${value}`)
    })
  )

  // Producer sets the value:
  yield* Effect.sleep("1 second")
  yield* Deferred.succeed(deferred, "hello")
  yield* Fiber.join(consumer)
})
```

Use Deferred for one-shot coordination between fibers — signaling completion, passing a single result, or implementing handshakes.

## Ref — shared mutable state

`Ref<A>` is an atomic mutable reference, safe for concurrent access:

```ts
import { Effect, Ref } from "effect"

const program = Effect.gen(function*() {
  const counter = yield* Ref.make(0)

  yield* Effect.all(
    Array.from({ length: 10 }, () =>
      Ref.update(counter, (n) => n + 1)
    ),
    { concurrency: "unbounded" }
  )

  const final = yield* Ref.get(counter)
  // final === 10 (all updates are atomic)
})
```

Variants:
- `Ref` — basic atomic reference
- `SynchronizedRef` — like Ref but `updateEffect` runs the effect atomically
- `SubscriptionRef` — emits a Stream of changes

## Queue — async message passing

`Queue<A>` is a bounded or unbounded async FIFO queue:

```ts
import { Effect, Queue } from "effect"

const program = Effect.gen(function*() {
  const queue = yield* Queue.bounded<string>(100)

  // Producer:
  yield* Effect.fork(
    Effect.forever(
      queue.offer("tick").pipe(Effect.delay("100 millis"))
    )
  )

  // Consumer:
  const msg = yield* Queue.take(queue) // suspends until available
  yield* Effect.log(`Received: ${msg}`)
})
```

- `Queue.bounded(n)` — backpressure when full (offer suspends)
- `Queue.unbounded()` — no limit (be careful with memory)
- `Queue.dropping(n)` — drops new items when full
- `Queue.sliding(n)` — drops oldest items when full

## PubSub — broadcast to multiple subscribers

`PubSub<A>` is a multi-subscriber broadcast hub. Each subscriber gets its own queue:

```ts
import { Effect, PubSub, Stream } from "effect"

const program = Effect.gen(function*() {
  const hub = yield* PubSub.bounded<string>(256)

  // Subscribers get independent streams:
  const stream = Stream.fromPubSub(hub)

  yield* Effect.fork(
    stream.pipe(Stream.runForEach((msg) => Effect.log(`Sub1: ${msg}`)))
  )

  yield* PubSub.publish(hub, "hello")
})
```

## Pool — resource pooling

`Pool<A, E>` manages a bounded set of reusable resources:

```ts
import { Effect, Pool } from "effect"

const program = Effect.gen(function*() {
  const pool = yield* Pool.make({
    acquire: createConnection,
    size: 10
  })

  // get borrows from pool, returns on scope exit:
  const result = yield* Pool.get(pool).pipe(
    Effect.flatMap((conn) => conn.query("SELECT 1")),
    Effect.scoped
  )
})
```

## Parallel combinators

```ts
// Run effects concurrently:
const [a, b, c] = yield* Effect.all([effectA, effectB, effectC], {
  concurrency: "unbounded"
})

// With bounded concurrency:
yield* Effect.forEach(items, processItem, { concurrency: 10 })

// Race — first to succeed wins:
const fastest = yield* Effect.race(effectA, effectB)

// Zip concurrently:
const [x, y] = yield* Effect.zip(effectA, effectB, { concurrent: true })
```

## Where to look in the codebase

- **Fiber**: `packages/effect/src/Fiber.ts` (public), `internal/fiber.ts` and `internal/fiberRuntime.ts` (execution engine)
- **Deferred**: `packages/effect/src/Deferred.ts` (public), `internal/deferred.ts`
- **Ref**: `packages/effect/src/Ref.ts`, `SynchronizedRef.ts`, `SubscriptionRef.ts`
- **Queue**: `packages/effect/src/Queue.ts`, `internal/queue.ts`
- **PubSub**: `packages/effect/src/PubSub.ts`, `internal/pubsub.ts`
- **Pool**: `packages/effect/src/Pool.ts`, `internal/pool.ts`
- **Fiber runtime**: `internal/fiberRuntime.ts` — the heart of the execution engine (~3800 lines)
