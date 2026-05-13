# Stream — patterns

## TL;DR

Reach for `Stream<A, E, R>` when values arrive over time and you want backpressure, cancellation, and resource safety baked in — push-style sources (VS Code event emitters, LSP `marimo/operation` notifications), pull-style sources (paginated APIs, async iterables), or any pipeline where buffering the whole sequence into an array is wrong. The three channels mirror `Effect`: `A` is each emitted element, `E` is the error type that terminates the stream, `R` is the required services. Streams are lazy and chunked; nothing runs until you `runDrain`/`runCollect`/`runForEach`. Forking a draining stream into a scope (`Effect.forkScoped`) is how the extension wires every long-lived subscription.

## Constructors & combinators

```ts
// pure
Stream.make(1, 2, 3); Stream.fromIterable(it); Stream.range(0, 10);
Stream.empty; Stream.never; Stream.fail(error);

// effectful / async  (see §3 for asyncPush/asyncScoped/asyncEffect)
Stream.fromEffect(eff); Stream.fromAsyncIterable(iter, onError);
Stream.paginate(seed, fn); Stream.paginateEffect(seed, fn);

// concurrent primitives & scoped
Stream.fromQueue(q); Stream.fromPubSub(ps);
Stream.scoped(eff); Stream.acquireRelease(acq, rel); Stream.ensuring(cleanup);
Stream.unwrap(eff); Stream.unwrapScoped(scopedEff);     // Effect<Stream> → Stream

// transformations
Stream.map(f); Stream.mapEffect(f, { concurrency });
Stream.filter(p); Stream.filterMap(f); Stream.tap(f);
Stream.take(n) / takeWhile / takeUntil; Stream.drop(n);
Stream.changes; Stream.debounce(d); Stream.throttle({...});
Stream.merge(s); Stream.mergeAll([...], { concurrency });
Stream.zip(s); Stream.zipLatest(s); Stream.interruptWhen(eff);
Stream.decodeText(encoding?);

// terminators
Stream.runDrain(s);                                   // Effect<void, E, R>
Stream.runCollect(s);                                 // DANGEROUS if infinite
Stream.runForEach(s, f); Stream.runFold(zero, step)(s);
Stream.runLast(s); Stream.toAsyncIterableRuntime(rt)(s);
```

## Bridging callback APIs with `Stream.asyncPush` / `asyncScoped` / `asyncEffect`

Three flavors, distinguished by what the register callback returns:

- **`asyncPush((emit) => scopedEff)`** — register returns `Effect<unknown, E, R | Scope>`; cleanup = the Scope's release. **Preferred** for VS Code `Disposable`-style listeners (~22 sites in `platform/VsCode.ts`, `lsp/LanguageClient.ts`).
- **`asyncScoped((emit) => scopedEff)`** — same scoped contract; older API. `emit` is the generic `Emit` (supports `emit.end()` / `emit.fail()` from inside).
- **`asyncEffect((emit) => Eff)`** — register returns a *non-scoped* `Effect`; use when there's no resource to release.

Gotcha: the callback returns a cleanup `Effect`, not raw teardown. `acquireDisposable` (`extension/src/lib/acquireDisposable.ts:8`) lifts `() => Disposable` to `Effect<Disposable, never, Scope>` via `Effect.acquireRelease`, slotting straight in:

```ts
// extension/src/lsp/LanguageClient.ts:223
streamOf<Notification extends MarimoLspNotification>(notification: Notification) {
  return Stream.asyncPush<MarimoLspNotificationOf<Notification>>((emit) =>
    acquireDisposable(() =>
      client.onNotification(notification, (msg) => emit.single(msg)),
    ),
  );
}
```

The `Disposable` is released on stream interruption automatically. Same shape: `platform/VsCode.ts:203,214,223,232,403,410,417,424,431,458` and `python/PythonExtension.ts:26,35`.

## Long-running consumption: `forkScoped` + `runDrain`/`runForEach`, with `interruptWhen` for cancellation

Both terminators are equally common; pick by where the work lives. `mapEffect(f) ∘ runDrain` and `runForEach(f)` produce identical results — pick the more readable shape.

- **`runDrain`** when the per-element effect is already in `mapEffect`/`tap` — the stream *is* the body. (`kernel/KernelManager.ts:82`)
  ```ts
  yield* Effect.forkScoped(client.streamOf("marimo/operation").pipe(
    Stream.mapEffect(Effect.fn(function* (msg) { yield* Queue.offer(queue, msg); })),
    Stream.runDrain));
  ```
- **`runForEach(f)`** when the handler *is* the body — no upstream `mapEffect`/`tap`. (`python/PythonEnvInvalidation.ts:19`)
  ```ts
  yield* Effect.forkScoped(pyExt.activeEnvironmentPathChanges().pipe(
    Stream.debounce(Duration.seconds(2)),
    Stream.runForEach(() => PubSub.publish(pubsub, "python-env-change"))));
  ```

**Cancellation idiom: `Stream.interruptWhen(effect)`** — halts the stream when the Effect completes. Bridge a `vscode.CancellationToken` via `Effect.async` (`platform/Api.ts:140`, `kernel/KernelManager.ts:235`):

```ts
const cancelled = Effect.async<void>((resume) => {
  if (token?.isCancellationRequested) resume(Effect.void);
  const d = token?.onCancellationRequested(() => resume(Effect.void));
  return Effect.sync(() => d?.dispose());
});
kernelManager.executeCodeUnsafe(uri, code).pipe(Stream.interruptWhen(cancelled), ...);
```

The internal-sentinel variant uses a `Deferred` resolved by a `Stream.tap` — see worked example 1.

**Wait-for-one idiom: `Stream.take(1)` + `Stream.runDrain`.** Blocks the fiber on a single emission without collecting:

```ts
// extension/src/lsp/TyLanguageServer.ts:200 — block until env invalidation, then let Effect.scoped clean up
yield* envInvalidation.changes().pipe(Stream.take(1), Stream.runDrain);
```

`Stream.unwrapScoped` (`extension/src/kernel/KernelManager.ts:241`) lifts an `Effect<Stream, …, Scope>` into a `Stream`, tying the resource scope to the stream scope.

## Worked examples (from this repo)

### 1. Scratchpad: scoped PubSub subscription + deferred-driven completion (`kernel/KernelManager.ts:211`)

Subscribe *before* sending the command (no missed first message), then halt the stream 50ms after `idle`. The subscription owns a `Scope`; `unwrapScoped` ties it to the returned stream's scope.

```ts
return Effect.gen(function* () {
  const sub = yield* PubSub.subscribe(scratchOps);   // owns a Scope.Scope
  yield* client.executeCommand({ /* execute-scratchpad */ });
  const sawIdle = yield* Deferred.make<void>();
  return Stream.fromQueue(sub).pipe(
    Stream.tap((op) =>
      op.status === "idle" ? Deferred.succeed(sawIdle, void 0) : Effect.void),
    Stream.interruptWhen(
      Deferred.await(sawIdle).pipe(Effect.zipRight(Effect.sleep("50 millis")))),
  );
}).pipe(scratchLock.withPermits(1), Stream.unwrapScoped);
```

### 2. Fold a byte stream into a string (Uv stdout)

`runFold` when you need the accumulated result; `tap` mirrors each chunk without disturbing it.

```ts
// extension/src/python/Uv.ts:486
return stream.pipe(
  Stream.decodeText(),
  Stream.tap((text) => { channel.append(text); return Effect.void; }),
  Stream.runFold(String.empty, String.concat),
);
```

### 3. `zipLatest` + `Stream.changes` (`features/ThemeSync.ts:20`)

`changes` de-dups consecutive equal emissions; `zipLatest` re-fires whenever *either* source emits. The `mapEffect` handler uses `Effect.fn("ThemeSync.sync")` to name the span, `annotateLogs` for variables, and catches errors *inside* the effect to keep the stream flowing.

```ts
Stream.zipLatest(
  code.window.colorThemeChanges().pipe(Stream.changes),
  editorRegistry.streamActiveNotebookChanges(),
).pipe(Stream.mapEffect(/* sync theme to kernel */), Stream.runDrain);
```

## Worked examples (from Effect itself)

```ts
// packages/effect/test/Stream/changing.test.ts — Stream.changes
Stream.fromIterable([1, 1, 1, 2, 2, 3, 4]).pipe(Stream.changes, Stream.runCollect);
// Chunk(1, 2, 3, 4)

// packages/effect/test/Stream/throttling.test.ts — token-bucket rate limit
Stream.fromQueue(queue).pipe(
  Stream.throttle({
    strategy: "shape",                       // "shape" waits, "enforce" drops
    cost: Chunk.reduce(0, (x, y) => x + y),
    units: 1, duration: Duration.seconds(1),
  }),
);
```

## Error handling

The `E` channel terminates the stream and is surfaced by the `run*` Effect.

```ts
Stream.catchAll((e) => Stream.empty); Stream.orElse(() => fallback);
Stream.catchTag("ParseError", (e) => Stream.fromEffect(retry));
Stream.catchTags({ ParseError: ..., TimeoutError: ... });
Stream.catchAllCause((cause) => ...);  // see defects + interrupts
Stream.either;                         // errors become Either<E, A>; no termination
```

- **`mapEffect` is the gateway between channels.** Typed error inside `mapEffect(f)` → stream-level `E`; uncaught defects become `Cause.Die` only visible via `catchAllCause` or logs. Catch *inside* the effect to keep flowing.
- **Finalizers run on success, failure, and interrupt.** `Stream.ensuring(cleanup)` = `try/finally`; `Stream.acquireRelease(acq, rel)` ties a resource's lifetime to the stream's.

Log-and-continue, as `KernelManager` does per-operation (`KernelManager.ts:97`):

```ts
Stream.mapEffect((msg) =>
  processOperation(msg).pipe(
    Effect.annotateLogs({ notebookUri: msg.notebookUri, operation: msg.operation.op }),
    Effect.withSpan("process-operation"),
    Effect.catchAllCause((cause) =>
      Effect.logError("Failed to process op").pipe(Effect.annotateLogs({ cause })),
    ),
  ),
);
```

## What to avoid

- **Don't `runCollect` an open-ended stream — use `runDrain`/`runForEach`.** `runCollect` only resolves when the stream ends; `marimo/operation`, VS Code listeners, and `PubSub`-backed streams never end. Silent memory leak; the Effect never resolves.
- **Don't use `Stream.async` with a `Disposable` — use `asyncPush` + `acquireDisposable`.** `async` takes a manual cleanup Effect; `asyncPush` is scoped. Mirror `platform/VsCode.ts`.
- **Don't run a resource-owning stream without a `Scope` — fork it scoped or wrap with `unwrapScoped`.** Bare `Runtime.runPromise(Stream.runDrain(s))` of an `asyncPush` stream leaks the listener. Convention: `yield* Effect.forkScoped(s.pipe(Stream.runDrain))` inside a scoped service.
- **Don't expect parallelism from `mapEffect(f)` — opt in.** Default is sequential, in order. Pass `{ concurrency: N }` (or `"unbounded"`); add `unordered: true` if you don't need order.
- **Don't reach for `runForEach` when you wanted a fold — use `runFold`/`runFoldEffect`.** `runForEach` returns `Effect<void>`; for accumulated values see `Uv.runString`.
- **Don't backpressure through an unbounded `Queue`.** `stream → Queue.unbounded → consumer` trades memory for throughput. `KernelManager`'s unbounded queue is deliberate (ordered processing of bursty kernel ops); bound otherwise.
- **No `as T` without a `// SAFETY:` comment.** Prefer `Schema`, type guards, or `assert(...)` inside `mapEffect` handlers — a wrong assertion bypasses the `E` channel entirely.
