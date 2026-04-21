# Streams

`Stream<A, E, R>` is a pull-based streaming abstraction with built-in backpressure. Think of it as an effectful, lazy, potentially infinite sequence of values — like an async generator but with typed errors, resource safety, and composable operators.

## Creating streams

```ts
import { Effect, Stream } from "effect"

// From values:
Stream.make(1, 2, 3)
Stream.fromIterable([1, 2, 3])
Stream.range(1, 10)

// From effects:
Stream.fromEffect(fetchUser(id))

// Repeated/unfolding:
Stream.repeat(fetchLatest, Schedule.spaced("1 second"))
Stream.unfold(0, (n) => Option.some([n, n + 1] as const))

// From async sources:
Stream.async<string>((emit) => {
  socket.on("message", (msg) => emit.single(msg))
  socket.on("error", (err) => emit.fail(new SocketError({ cause: err })))
  socket.on("close", () => emit.end())
})

// From Queue or PubSub:
Stream.fromQueue(queue)
Stream.fromPubSub(pubsub)

// Chunked for efficiency:
Stream.fromChunk(Chunk.make(1, 2, 3))
```

## Transforming streams

```ts
stream.pipe(
  Stream.map((x) => x * 2),
  Stream.filter((x) => x > 10),
  Stream.take(100),
  Stream.mapEffect((x) => processItem(x)),            // effectful transform
  Stream.mapEffect((x) => processItem(x), { concurrency: 5 }), // concurrent
  Stream.flatMap((x) => Stream.make(x, x + 1)),       // 1-to-many
  Stream.tap((x) => Effect.log(`Processing: ${x}`)),
  Stream.scan(0, (acc, x) => acc + x),                 // running accumulation
  Stream.debounce("500 millis"),
  Stream.throttle({ units: 10, duration: "1 second", strategy: "shape" }),
  Stream.grouped(100),                                  // batch into chunks
  Stream.groupByKey((item) => item.category),           // partition by key
)
```

## Consuming streams

```ts
// Collect all values:
const items = yield* Stream.runCollect(stream) // returns Chunk<A>

// Process each value:
yield* Stream.runForEach(stream, (item) => processItem(item))

// Fold into a single result:
const sum = yield* Stream.runFold(stream, 0, (acc, n) => acc + n)

// Take the first value:
const first = yield* Stream.runHead(stream)

// Drain (run for side effects only):
yield* Stream.runDrain(stream)

// Into a Sink:
yield* stream.pipe(Stream.run(mySink))
```

## Sink — stream consumers

A `Sink<A, In, L, E, R>` describes how to consume stream elements and produce a result:

```ts
import { Sink, Stream } from "effect"

// Built-in sinks:
Sink.collectAll()           // collect into Chunk
Sink.fold(0, () => true, (acc, n: number) => acc + n)  // fold
Sink.forEach((item) => processItem(item))               // side-effect each
Sink.take(10)               // take first 10 elements

// Use with Stream.run:
const result = yield* stream.pipe(Stream.run(Sink.collectAll()))
```

## Channel — the low-level primitive

`Channel` is the underlying primitive that both `Stream` and `Sink` compile to. You rarely use it directly, but understanding it helps when you need to build custom stream operators. A Channel reads input, writes output, and can fail or succeed — it's the I/O kernel beneath the streaming abstractions.

## Where to look in the codebase

- **Stream public API**: `packages/effect/src/Stream.ts` — all constructors and combinators
- **Sink public API**: `packages/effect/src/Sink.ts`
- **Channel**: `packages/effect/src/Channel.ts` — the low-level I/O primitive
- **Chunk**: `packages/effect/src/Chunk.ts` — efficient batch data structure used throughout streaming
- **Stream internals**: `packages/effect/src/internal/stream/` and `internal/core-stream.ts`
- **Channel internals**: `packages/effect/src/internal/channel/`
