# State primitives — patterns

## TL;DR

Effect has four state primitives. They form a small inclusion lattice:

```
Ref  <  SynchronizedRef  <  SubscriptionRef          Deferred (one-shot)
```

- `Ref<A>` — synchronous get/set/`modify`. Cheapest. No effectful update.
- `SynchronizedRef<A>` — adds `updateEffect`/`modifyEffect`; runs the update body inside a per-ref semaphore so concurrent effectful updates serialize.
- `SubscriptionRef<A>` — `extends SynchronizedRef`, so you get both: effectful updates **and** a `.changes: Stream<A>` for broadcast.
- `Deferred<A, E>` — write-once cell; multiple fibers can `await`.

All state in this repo lives inside a `Layer.effect` / `Effect.Service` body so its lifetime is tied to the scope. None at module scope.

## Picking the right primitive (decision tree)

```
Need a value set exactly once that other fibers wait on?
  -> Deferred                     (dap-proxy.ts:147, KernelManager.ts:227)
Need other consumers to observe changes as a Stream?
  -> SubscriptionRef              (VariablesService.ts:34, DatasourcesService.ts:90)
The update function returns an Effect (does IO / opens a Scope / may fail)?
  -> SynchronizedRef              (ControllerRegistry.ts:69)
Otherwise:
  -> Ref                          (ExecutionRegistry.ts:103, RecentNotebooks.ts:54)
```

`SubscriptionRef extends SynchronizedRef` — if you need broadcast AND your updates are effectful, one `SubscriptionRef` covers both; don't reach for `SynchronizedRef` separately.

## Constructors & combinators

```ts
import { Ref, SynchronizedRef, SubscriptionRef, Deferred } from "effect"
```

`Ref<A>` (`repos/effect/packages/effect/src/Ref.ts:69-180`):

- `Ref.make(a): Effect<Ref<A>>`, `Ref.get(ref)`, `Ref.set(ref, a)`.
- `Ref.update(ref, (a) => a)` — pure update, returns `void`.
- `Ref.modify(ref, (a) => [b, a'])` — atomic read-derive-write; returns `b`. Reach for this when the new state depends on the old.
- Plus `updateAndGet`, `getAndUpdate`, `getAndSet`, `updateSome`, `modifySome`.
- Ergonomic: `Ref<A> extends Effect<A>` (`Ref.ts:27`), so `const v = yield* myRef` reads as a get. `Ref.get(myRef)` is the grep-friendly form; same compile.

`SynchronizedRef<A>` (`SynchronizedRef.ts:29`) — inherits `Ref`, adds:

- `SynchronizedRef.updateEffect(ref, (a) => Effect<A, E, R>)` — atomic effectful update.
- `SynchronizedRef.modifyEffect(ref, (a) => Effect<[B, A], E, R>)` — atomic effectful read-derive-write.

`SubscriptionRef<A>` (`SubscriptionRef.ts:35`) — inherits `SynchronizedRef`, adds `ref.changes: Stream<A>` (multi-subscriber).

`Deferred<A, E>` (`Deferred.ts:40`):

- `Deferred.make<A, E>(): Effect<Deferred<A, E>>`.
- `Deferred.await(d): Effect<A, E>` — suspends until completed. `Deferred<A, E> extends Effect<A, E>`, so `yield* d` works.
- `Deferred.succeed/fail/done` — return `Effect<boolean>` (`true` = this call wrote it). Idempotent.

## `SynchronizedRef` vs. `Ref.updateEffect` (which does not exist)

`Ref` has **no** `updateEffect` or `modifyEffect`. The full export list is in `repos/effect/packages/effect/src/Ref.ts:69-180`; you'll find `update`, `modify`, `updateAndGet`, `updateSome`, `modifySome`, but nothing that takes an `Effect`. The callback for `Ref.update` is `(a: A) => A` — synchronous, pure. Hand it a function that returns an `Effect` and you store the `Effect` value itself as the new state. No type error, silent data corruption.

Reach for `SynchronizedRef` (or `SubscriptionRef`, which extends it) the moment the update body does anything effectful — IO, calling another service, opening a `Scope`, anything that can fail in a typed way. `SynchronizedRef.updateEffect` holds an internal semaphore for the duration of the inner effect, so two concurrent updates serialize cleanly.

Canonical pattern from `extension/src/kernel/ControllerRegistry.ts:77` (finalizer closes every scope in the map atomically):

```ts
yield* Effect.addFinalizer(() =>
  SynchronizedRef.updateEffect(
    handlesRef,
    Effect.fn(function* (map) {
      yield* Effect.forEach(
        HashMap.values(map),
        ({ scope }) => Scope.close(scope, Exit.void),
        { discard: true },
      );
      return HashMap.empty();
    }),
  ),
);
```

And `extension/src/kernel/ControllerRegistry.ts:291` — check existence, otherwise allocate a `Scope` and register the new controller, all under one lock:

```ts
yield* SynchronizedRef.updateEffect(
  handlesRef,
  Effect.fn(function* (map) {
    const existing = HashMap.get(map, controllerId);
    if (Option.isSome(existing)) {
      yield* existing.value.controller.mutateDescription(controllerLabel);
      return map;
    }
    const scope = yield* Scope.make();
    const controller = yield* Scope.extend(/* ... */, scope);
    return HashMap.set(map, controllerId, { controller, scope });
  }),
);
```

The "prune stale controllers" path at `ControllerRegistry.ts:344` follows the same shape: read sibling state, decide what to remove, close scopes, return the new map — all atomic.

Repo convention: prefer `Effect.fnUntraced(function* (a) { ... })` for the inner update body (avoids spawning one span per atomic update); reserve `Effect.fn("namespace.op")` for the *outer* named operation.

## `SubscriptionRef.changes` semantics (replay-on-subscribe)

`ref.changes` is a multi-subscriber `Stream<A>` and **emits the current value to each new subscriber on subscribe**, then every subsequent `set`/`update`. Replay-on-subscribe is real and intentional — the test comment at `extension/src/panel/variables/__tests__/VariablesService.test.ts:287` exists exactly to call this out:

```ts
// Expects 4 because SubscriptionRef.changes emits current value on subscription (empty map)
// plus the 3 updates
```

What it does **not** do: dedup consecutive equal values. Two `update(map, identity)` calls produce two emissions. If you only care about real changes, pipe through `Stream.changes` (different `changes` — the `Stream` combinator that drops consecutive duplicates).

Standard consumer pattern in this repo — produce the stream from a service, pair with `Stream.changes` for dedup, drive it with `Effect.forkScoped` + `Stream.runForEach` so it tears down with the scope:

```ts
// producer side (VariablesService.ts:191)
streamVariablesChanges() {
  return variablesRef.changes.pipe(Stream.changes);
}

// consumer side (DatasourcesView.ts:379)
yield* Effect.forkScoped(
  datasourcesService.streamConnectionsChanges().pipe(
    Stream.mapEffect(() => refreshDatasources()),
    Stream.runDrain,
  ),
);
```

Pipe `.changes` through `Stream.changes` at the producer so no-op `set`/`update` calls don't propagate to subscribers. Returning raw `.changes` is only safe when the consumer is known to debounce.

## Worked examples (from this repo)

**`Ref.modify` for atomic read-derive-write** — `extension/src/kernel/ExecutionRegistry.ts:103`:

```ts
const cell = yield* Ref.modify(ref, (map) => {
  const prev = Option.match(HashMap.get(map, cellId), {
    onSome: (cell) => cell,
    onNone: () => CellEntry.make(cellId, editor),
  });
  const update = CellEntry.transition(prev, msg);
  return [update, HashMap.set(map, cellId, update)];
});
```

No TOCTOU window between read and write; the new entry and the new map are produced together.

**`Ref` for plain mutable state behind a tree view** — `extension/src/panel/RecentNotebooks.ts:54`. Sync reads in `getChildren`, sync writes in command handlers. No subscribers, no effectful updates: stay on `Ref`.

**`SubscriptionRef` + `.changes` driving a tree view** — `extension/src/panel/variables/VariablesService.ts:34`. The view subscribes once, gets the current value immediately (replay), then live deltas. `Stream.changes` strips no-op emissions.

**`Deferred` for one-shot coordination** — `extension/src/lib/dap-proxy.ts:147`. The proxy returns `ready: Deferred.await(configurationDone)`; the message handler completes it when DAP's `configurationDone` arrives. And `extension/src/kernel/KernelManager.ts:227` uses `Deferred<void>` to gate `Stream.interruptWhen` on "first idle, then 50ms" — the deferred flips once, the stream tears down 50ms later.

## Worked examples (from Effect itself)

**`Ref.modify` returning derived + new state** (`repos/effect/packages/effect/src/Ref.ts:108`):

```ts
const ref = yield* Ref.make("old")
const greeting = yield* Ref.modify(ref, () => ["hello", "new"] as const)
// greeting === "hello"; ref now holds "new"
```

**`SynchronizedRef.modifyEffect` signature** (`repos/effect/packages/effect/src/SynchronizedRef.ts:30`):

```ts
modifyEffect<B, E, R>(f: (a: A) => Effect.Effect<readonly [B, A], E, R>): Effect.Effect<B, E, R>
```

**`SubscriptionRef extends SynchronizedRef`** (`repos/effect/packages/effect/src/SubscriptionRef.ts:35`): so any of `update`, `updateEffect`, `modifyEffect`, `get`, `set` works on it. Pick `SubscriptionRef` once any consumer wants `.changes`; don't stack a `SynchronizedRef` next to it.

## Error handling

- `Ref.update`/`Ref.modify` callbacks are pure `(A) => A` / `(A) => [B, A]`. Throwing inside defects a fiber — no error channel. Validate before calling.
- `SynchronizedRef.updateEffect` propagates the inner `E`/`R`. The new value is stored only on `Exit.Success`; failures leave the previous value in place. Wrap with `Effect.tapError` / `Effect.catchAll` *inside* the update body if you want "set on success, log on failure."
- `Deferred.succeed`/`fail`/`done` return `Effect<boolean>` (`true` = this call completed it). Idempotent — don't assert on the boolean unless you care which fiber won.
- `Deferred.await` is cancelled by normal scope teardown; no manual timeout needed.

## What to avoid

- **`Ref.update`/`Ref.modify` with an `Effect`-returning callback** — there's no `Ref.updateEffect`. The callback type is `(a: A) => A`. Passing `(a) => Effect.succeed(...)` stores the `Effect` value as the new state. Use `SynchronizedRef.updateEffect` instead.
- **Read-then-write with `Ref.get` + `Ref.set`** — race window between the two. Use `Ref.modify` for sync, `SynchronizedRef.modifyEffect` for effectful.
- **`SubscriptionRef` for state nothing subscribes to** — you're paying for a `PubSub` + semaphore for no benefit. Start on `Ref`; upgrade when a second consumer wants `.changes`.
- **Forgetting `Stream.changes` after `ref.changes`** — every `set`/`update` emits, even no-op updates. Dedup at the producer (`VariablesService` and `MarimoConfigurationService` show the pattern).
- **`Effect.fn("...")` inside `SynchronizedRef.updateEffect` callbacks** — each atomic update gets its own span. Use `Effect.fnUntraced(function* (a) { ... })` for the inner update; trace the outer named operation instead.
- **Module-scope state** — `Ref.make` outside a `Layer.effect`/`scoped` body escapes the scope, never finalizes, leaks across tests. Every state primitive in this repo lives inside an `Effect.Service`.
- **A `Ref<Option<A>>` + busy-poll for "wait until set"** — that's `Deferred`. Use `Deferred.make` + `Deferred.await` + `Deferred.succeed`.
