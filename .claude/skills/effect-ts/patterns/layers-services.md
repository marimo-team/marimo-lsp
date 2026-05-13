# Layer & Context — service patterns

## TL;DR

In `Effect<A, E, R>` the `R` channel is a **set of `Context.Tag`s** the effect needs. A `Layer<ROut, E, RIn>` is a recipe that produces those tags. Pick the constructor by **what the build step does**: `Layer.succeed`/`sync` for pure values; `Layer.effect` for an `Effect` build with no cleanup; `Layer.scoped` when the service owns a resource that must be released (forked fibers, subscriptions, sockets). In this repo we almost always reach for `Effect.Service<Self>()("Name", { effect | scoped, dependencies })` — it bundles tag + live layer + `.Default` in one class. Top-level assembly lives in `extension/src/features/Main.ts`; platform tags (`VsCode`, `LanguageClient`, `Telemetry`, `Sentry`, ...) come from the caller and are wired in at activation.

## Constructors & combinators

All cites: `repos/effect/packages/effect/src/Layer.ts`.

- `Layer.succeed(tag, value)` — wrap an already-built value as a layer. (Layer.ts:772)
- `Layer.sync(tag, () => value)` — same, but defer construction. (Layer.ts:801)
- `Layer.effect(tag, effect)` — build the service with an `Effect`; no acquire/release. (Layer.ts:289)
- `Layer.effectDiscard(effect)` — run an `Effect` for its side effects; contributes nothing to `R`. (Layer.ts:300)
- `Layer.scoped(tag, effect)` — `Effect` may use `Scope`; finalizers run on layer teardown. (Layer.ts:727)
- `Layer.scopedDiscard(effect)` — side-effect-only scoped layer (registering commands, forking listeners). (Layer.ts:743)
- `Layer.merge(a, b)` / `Layer.mergeAll(...)` — combine peer layers; outputs union, inputs union. (Layer.ts:567, 583)
- `Layer.fresh(self)` — opt out of memoization; rebuilt at each provision site. (Layer.ts:397)
- `Layer.empty` — neutral element for `Layer.merge`. (Layer.ts:318)

**`Layer.provide` vs `Layer.provideMerge`.** Both feed `that`'s outputs into `self`'s inputs. The difference is what survives in the result:

- `Layer.provide(self, that)` — `that`'s outputs are **hidden** from the result. Use this when `that` is a private dependency of `self`. (Layer.ts:899)
- `Layer.provideMerge(self, that)` — `that`'s outputs are **kept** in the result alongside `self`'s. Use this when the caller still needs to read `that` back out. (Layer.ts:936)

In `features/Main.ts:84` `Api.Default` is provided with `provideMerge` precisely because `extension.ts` does `Context.get(ctx, Api)` after building (Main.ts:148). Everything else (`KernelManager`, `Storage`, ...) is `Layer.provide` — internal plumbing the caller never sees.

## `Effect.Service` vs `Context.Tag` (when to reach for each)

**Rule:** use `Effect.Service` unless the value is supplied by the host.

`Effect.Service<Self>()(id, { effect | scoped, dependencies })` synthesizes the tag, the live `Layer`, a `.Default` exposing that layer, and a `.make({...})` constructor that types the shape. The class **is** the tag: `yield* Constants` returns the shape; `Constants.Default` is the live `Layer`.

```ts
// extension/src/platform/Constants.ts:5
export class Constants extends Effect.Service<Constants>()("Constants", {
  dependencies: [Config.Default],            // pre-provided to .Default
  effect: Effect.gen(function* () {
    const config = yield* Config;
    const enabled = yield* config.getManagedLanguageFeaturesEnabled();
    return { LanguageId: { Python: enabled ? "mo-python" : "python" } } as const;
  }),
}) {}
```

`Context.Tag(id)<Self, Shape>` (Context.ts:524) is the raw primitive. Use it **only** when the shape is owned by someone else — there's nothing for us to build, we only need an injection point. The canonical exception in this repo is `ExtensionContext`, the slice of `vscode.ExtensionContext` handed in at `activate()`:

```ts
// extension/src/platform/Storage.ts:15
export class ExtensionContext extends Context.Tag("ExtensionContext")<
  ExtensionContext,
  Pick<vscode.ExtensionContext,
    "workspaceState" | "globalState" | "extensionUri" | "globalStorageUri">
>() {}
```

It's the only `Context.Tag` in `extension/src` for this exact reason. Everything else is `Effect.Service`.

Two cross-cutting facts about `Effect.Service`:

- `dependencies: [...]` pre-provides those layers to `.Default` — they no longer appear in `RIn`. Use when a dependency is always the same in production; leave it out when the dependency must be substituted at the boundary (e.g. `VsCode`, `LanguageClient`).
- `effect` vs `scoped` is the same trade-off as `Layer.effect` vs `Layer.scoped`. If you yield anything that needs cleanup (`PubSub`, `Queue`, `Effect.forkScoped`, `Effect.acquireRelease`), use `scoped`.

## Side-effect-only layers: `scopedDiscard` vs `effectDiscard`

Both produce `Layer<never, E, R>` — nothing added to the context. The difference is whether the build runs inside a `Scope`:

- **`Layer.scopedDiscard`** — finalizers fire on layer teardown. Use when you `Effect.forkScoped`, run a `Stream`, register a `vscode.Disposable`, or otherwise need cleanup. **12 sites** in `extension/src` (all `features/`, `panel/*/View`, `statusbar/*Live`).
- **`Layer.effectDiscard`** — fire-and-forget. No `Scope`, no cleanup. **1 site**: `features/DebugLayer.ts`.

**`scopedDiscard` — listener that must die on dispose:**

```ts
// extension/src/features/MarimoFileDetector.ts:10
export const MarimoFileDetectorLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    yield* updateContext(yield* code.window.getActiveTextEditor());
    yield* Effect.forkScoped(                            // fiber tied to scope
      code.window.activeTextEditorChanges()
        .pipe(Stream.mapEffect(updateContext), Stream.runDrain),
    );
  }),
);
```

The forked fiber's lifetime is the layer's scope; `MainLive` shutdown interrupts it.

**`effectDiscard` — mutate global state once, no teardown:**

```ts
// extension/src/features/DebugLayer.ts:24
export const DebugLayerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    if (process.env.MARIMO_DEBUG !== "1") return;
    globalThis.__marimoDebug = {
      controllerRegistry: yield* ControllerRegistry,
      cellStateManager: yield* CellStateManager,
      // ...
    };
  }),
);
```

Nothing to release — we set `globalThis.__marimoDebug` and walk away. If you want `effectDiscard` but also want cleanup, you want `scopedDiscard`.

## Worked examples (from this repo)

**Scoped service that owns resources.** `scoped` build + `Effect.forkScoped`, so fibers die when the layer's scope closes.

```ts
// extension/src/kernel/KernelManager.ts:53
export class KernelManager extends Effect.Service<KernelManager>()("KernelManager", {
  dependencies: [Uv.Default, Config.Default, /* ... */ NotebookRenderer.Default],
  scoped: Effect.gen(function* () {
    const client = yield* LanguageClient;
    const queue = yield* Queue.unbounded<MarimoOperation>();
    yield* Effect.forkScoped(
      client.streamOf("marimo/operation").pipe(
        Stream.mapEffect((msg) => Queue.offer(queue, msg)),
        Stream.runDrain,
      ),
    );
    return { /* methods */ };
  }),
}) {}
```

**Service depending on a host-provided tag.** `Storage` reads `ExtensionContext`; the tag is satisfied at `Effect.provideService(ExtensionContext, context)` in `features/Main.ts:154`.

```ts
// extension/src/platform/Storage.ts:136
export class Storage extends Effect.Service<Storage>()("Storage", {
  effect: Effect.gen(function* () {
    const context = yield* ExtensionContext;
    return {
      workspace: new MementoStorage<"workspace">(context.workspaceState),
      global: new MementoStorage<"global">(context.globalState),
    };
  }),
}) {}
```

**Assembly graph.** `MainLive` is the *only* place that knows the full wiring. Top tier `Layer.merge`s features; each subsequent `.pipe` block `Layer.provide`s services, peeling tags off `R` until only platform tags remain — satisfied by the caller's `layer` at `Layer.provide(MainLive, layer)` (`features/Main.ts:145`). `Api.Default` uses `provideMerge` so activation can read it back out; everything else uses `provide`.

### Escape hatch: manual scope + `Layer.buildWithScope`

99% of the time the right tool is `Effect.provide(effect, layer)`. The one place this repo manually builds a layer is `features/Main.ts:143-152`, because VS Code's `activate()` returns a `Disposable` whose `dispose()` is called by the host on deactivation — there's no enclosing `Effect` whose lifetime we can tie the scope to.

```ts
// extension/src/features/Main.ts:143
const scope = yield* Scope.make();
const ctx = yield* Layer.buildWithScope(
  Layer.provide(MainLive, layer),
  scope,
);
const api = Context.get(ctx, Api);
return {
  experimental: api.experimental,
  dispose: () => Effect.runPromise(Scope.close(scope, Exit.void)),
};
```

`Api` is read back out of `Context` (which is why it's provided with `provideMerge`), and `dispose` closes the scope — running every `forkScoped` / `acquireRelease` finalizer transitively. Escape hatch for callback-driven host lifecycles (VS Code `activate`, Node `process.on('exit')`); not a peer-level pattern — don't reach for it inside ordinary effects.

## Worked examples (from Effect itself)

**`Layer.fresh` to break memoization** — `repos/effect/packages/effect/test/Layer.test.ts:196`:

```ts
const env = layer.pipe(Layer.merge(Layer.fresh(layer)), Layer.build);
// acquire1, acquire1, release1, release1 — built twice
```

**`Layer.scopedDiscard` / `Layer.effectDiscard`** are the public side-effect-only constructors (`Layer.ts:300, 743`). The repo convention mirrors Effect's own usage: anything that "registers stuff and watches it" is `scopedDiscard` so the scope handles `dispose()`.

## Error handling

Errors a layer can fail with end up in `E` of `Layer<ROut, E, RIn>`. In practice:

- Fail early in the build step (`yield* Effect.fail(...)` or a tagged error) — the `Effect.runPromise` at activation surfaces it as a rejected promise and VS Code shows it. Don't `try`/`catch` to swallow startup errors; failing loud is correct.
- `Layer.catchAll` recovers with a fallback layer (rare here).
- Finalizer errors in scoped layers go through Effect's defect channel — they won't fail the surrounding effect but will log.

For tagged errors crossing layer boundaries, use `Data.TaggedError` (e.g. `StorageError` at `extension/src/platform/Storage.ts:4`).

## What to avoid

**Don't** turn every helper into a service. Plain functions don't need a tag and a layer. Use a service when there's identity (someone caches/holds state), substitutability (you want to mock it), or a lifecycle (a `Scope` finalizer). Pure transforms stay as exported functions.

**Don't** mock with `{} as FooService` (or `as unknown as FooService`) — the type-system contract is off; adding a method to `FooService` won't break the test, it will silently call `undefined(...)`. Test mocks must `implements` the full interface: either `Foo.make({...})` (every method typed; use `Effect.die("not implemented")` for ones the test shouldn't touch — see `extension/src/__mocks__/TestSentry.ts`), or the `partialService<T>(partial)` `Proxy` helper in `extension/src/__tests__/__utils__/partial.ts:5` that throws on unimplemented access. Both keep boundary violations loud. See `CLAUDE.md` "Prefer Schema or type guards over type assertions".

**Don't** call `Effect.provide(someLayer)` inside a hot path. Each provide builds (or memoizes) the layer; doing it per-event burns scope allocations for no reason. Provide once at the **boundary** (extension activate, test setup, `Main.ts` assembly) and let inner effects pull tags from `R` for free.

**Don't** call `Layer.build` / `Layer.buildWithScope` manually unless you genuinely need a `Context.Context<R>` to read back out — the right tool 99% of the time is `Effect.provide(effect, layer)`. `features/Main.ts:144` is the documented exception.

**Don't** reach for `Layer.fresh` to "fix" weird sharing bugs. Memoization is the default for good reason. Use `fresh` only when you've decided you genuinely want two independent instances *and* documented why.
