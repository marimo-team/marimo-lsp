# Testing Effect code — patterns

## TL;DR

Use `@effect/vitest` for every Effect-based unit test in `extension/src/**/__tests__/*.test.ts`. Default to **`it.effect`** — your `Effect` runs on a runtime with `TestClock` + `TestServices` already wired up, so time is deterministic. Use **`it.scoped`** when the test needs a `Scope` (forked fibers subscribing to a `PubSub`, `Effect.acquireRelease`, layer-owned subscriptions). Share services across a `describe` with **`it.layer(MyLayer)((it) => { ... })`**.

Rule of thumb: `TestClock.adjust("X millis")` after every event you publish, once per fiber yield-point between push and assert. If the assertion races the consumer fiber, you forgot an `adjust`.

## Constructors & combinators

```ts
import { assert, describe, expect, it } from "@effect/vitest";

it.effect("name", Effect.fn(function*() { /* TestClock + TestServices */ }))
it.scoped("name", Effect.fn(function*() { /* + Scope */ }))
it.layer(MyLayer)((it) => { /* share layer across siblings */ })
it.layer(MyLayer)("group", (it) => { /* same, wrapped in describe */ })
it.flakyTest(effect, "30 seconds")
it.prop("name", arbs, ([x]) => Effect.gen(...))
```

Citations: `repos/effect/packages/vitest/src/index.ts:186` (`effect`), `:191` (`scoped`), `:245` (`layer`), `:260` (`flakyTest`), `:268` (`prop`). `it.effect`/`it.scoped` auto-resolve `TestServices` (`:131`, `:137`). `describe`/`expect`/`assert` re-export from vitest (`:17`). Use `assert(cond, msg)` for invariants that narrow types (`Either.isLeft(r)`); `expect(...).toMatchInlineSnapshot(...)` for value assertions.

## Worked examples (from this repo)

**`it.effect` + per-test fixture** — `extension/src/notebook/__tests__/CellStateManager.test.ts:46`:

```ts
it.effect("getNotebookCellId returns consistent cell IDs", Effect.fn(function*() {
  const ctx = yield* withTestCtx();
  yield* Effect.gen(function*() {
    const code = yield* VsCode;
    // ...build cells, assert IDs are stable across reads...
  }).pipe(Effect.provide(ctx.layer));
}));
```

The `withTestCtx` fixture (`:16`) returns fresh `Ref`/`Queue`/`PubSub` per test plus a `layer` to provide — preferred over `it.layer` when each test wants independent capture state.

**`it.scoped` driving a stream via PubSub** — `extension/src/kernel/__tests__/KernelManager.test.ts:142`:

```ts
it.scoped("prompts for input on stdin cell-op", Effect.fn(function*() {
  const ctx = yield* withTestCtx();
  yield* Effect.gen(function*() {
    yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
    yield* TestClock.adjust("1 millis");
    yield* PubSub.publish(ctx.operationsPubSub, makeIdleCellOperation(/*...*/));
    yield* TestClock.adjust("1 millis");
    yield* Queue.offer(ctx.inputQueue, Option.some("foo"));
    yield* TestClock.adjust("1 millis");
    const cmds = yield* Ref.get(ctx.executions);
    expect(cmds.find((c) => c.params.method === "send-stdin")).toMatchObject({/*...*/});
  }).pipe(Effect.provide(ctx.layer));
}));
```

Pattern: publish/offer → `TestClock.adjust("1 millis")` so the subscriber fiber runs → assert on the captured `Ref`. `it.scoped` because the layer forks fibers that need a `Scope` to clean up.

## Worked examples (from Effect itself)

**Nested `it.layer`** — `repos/effect/packages/vitest/src/index.ts:222`:

```ts
layer(Foo.Live)("layer", (it) => {
  it.effect("adds context", () => Effect.gen(function*() {
    expect(yield* Foo).toEqual("foo");
  }));
  it.layer(Bar.Live)("nested", (it) => {
    it.effect("composes", () => Effect.gen(function*() {
      expect([yield* Foo, yield* Bar]).toEqual(["foo", "bar"]);
    }));
  });
});
```

**`Effect.fork` + `TestClock.adjust` for `timeout`** — `repos/effect/packages/effect/src/TestClock.ts:50`:

```ts
const fiber = yield* pipe(
  Effect.sleep(Duration.minutes(5)),
  Effect.timeout(Duration.minutes(1)),
  Effect.fork,
);
yield* TestClock.adjust(Duration.minutes(1));
assert.deepStrictEqual(yield* Fiber.join(fiber), Option.none());
```

Without `Effect.fork`, the test fiber blocks on `sleep` before reaching `adjust` (`TestClock.ts:67-73`).

## Layer-scoped fixtures (`it.layer` / `Layer.fresh`)

`it.layer(L)((it) => { ... })` builds `L` **once** for the whole group; every `it.effect`/`it.scoped` inside sees the same service instances. Use it when the layer is expensive to build (subprocess, real fs), or tests are read-only assertions over a shared service graph (`EnvironmentValidator.test.ts:45`). Per-test `Effect.provide(layer)` wins when each test needs an independent captured `Ref`/`Queue` (`CellStateManager.test.ts:16-43`).

**`Layer.fresh` rebuilds the layer per test** inside `it.layer`. Required when the layer owns a destructible resource each test consumes:

```ts
// extension/src/python/__tests__/Uv.test.ts:44
it.layer(Layer.fresh(UvLive))((it) => {
  it.scoped("should create a new python venv", Effect.fn(function*() {
    const uv = yield* Uv;
    const tmpdir = yield* TmpDir;   // <- fresh scoped TmpDir per test
    yield* uv.venv(NodePath.join(tmpdir.path, ".venv"), { python });
  }), { timeout: 30_000 });
});
```

`TmpDir` is a scoped `Effect.Service` (`Uv.test.ts:19-33`) that `mkdtempDisposableSync` on acquire and removes on release. Without `Layer.fresh`, tests would share one temp dir and step on each other. `EnvironmentValidator.test.ts:45` skips `Layer.fresh` because each test makes its own `.venv` subdir.

## TestClock idioms ("push → adjust → assert")

`TestClock` is in `effect`, not `@effect/vitest`. Inside `it.effect`/`it.scoped`, `Effect.sleep`, `Effect.timeout`, `Schedule.spaced`, `Stream` debouncing, and `SubscriptionRef.changes` all wait on the test clock.

```ts
import { TestClock } from "effect";

TestClock.adjust("100 millis")         // advance clock; wake sleeps ≤ new time
TestClock.setTime(1_700_000_000_000)   // jump to absolute epoch ms
TestClock.sleeps                       // Effect<Chunk<number>> — pending wake times
```

Citations: `repos/effect/packages/effect/src/TestClock.ts:77` (`adjust`), `:80` (`setTime`), `:193` (`sleep`), `:218` (`sleeps`).

**Canonical "push → adjust → assert" loop** (30+ sites; representative: `VariablesService.test.ts:255`):

```ts
yield* Effect.fork(service.streamVariablesChanges().pipe(
  Stream.mapEffect(() => Ref.update(collected, (n) => n + 1)),
  Stream.runDrain,
));
yield* TestClock.adjust("10 millis");          // let subscription attach
yield* service.updateVariables(uri, op1);
yield* TestClock.adjust("10 millis");          // let subscriber see op1
yield* service.updateVariables(uri, op2);
yield* TestClock.adjust("10 millis");
assert.strictEqual(yield* Ref.get(collected), 3);
```

Why `"10 millis"` over `"1 millis"`? Both yield; repo settled on 10ms for service-level tests because some services have small internal debounce windows that 1ms silently swallows. For tests without a debouncer, `1 millis` is fine (`KernelManager.test.ts:152`). **`Effect.fork` is mandatory for long `sleep`/`timeout`** — `yield*`-ing an effect that sleeps longer than the next `adjust` blocks the test fiber forever.

## Inline snapshots (`toMatchInlineSnapshot`)

Inline snapshots earn their keep (CLAUDE.md "Snapshot tests pull a lot of weight"): expected shape lives next to the test, regressions surface as line-by-line diffs, reviewers can sanity-check protocol output in the PR diff. ~18 test files in `extension/src` use them.

**Snapshot when the value is:** a protocol message captured from `executeCommand` (`CellStateManager.test.ts:148`); a diagnostics array from a validator (`EnvironmentValidator.test.ts:77,110`); serialized output / a formatted file (`Uv.test.ts:112`); a `Chunk` collected from a `Stream` (`ConfigContextManager.test.ts:275`).

```ts
// extension/src/notebook/__tests__/CellStateManager.test.ts:148
expect(commands).toMatchInlineSnapshot(`
  [{ "command": "marimo.api", "params": { "method": "delete-cell",
       "params": { "inner": { "cellId": "cell-1" },
                   "notebookUri": "file:///test/notebook.py" } } }]
`);
```

**Regenerate:** `just test-ts -u` (or `pnpm -C extension test -u`). Python: `uv run pytest --inline-snapshot=create` (or `=fix`). See `CLAUDE.md:113`.

**Non-deterministic fields:** repo does not use `dirty-equals`. Strip/stub before snapshotting, or use `toMatchObject({...})` for partial matches (`KernelManager.test.ts:182`). For binary payloads, normalize first — `normalizeOutputsForSnapshot` (`ExecutionRegistry.test.ts:66`) decodes `Uint8Array` to strings; that file uses file-based `toMatchSnapshot` (`:107`) for large payloads.

## Mock conventions (`Layer.succeed` vs `Layer.scoped`, `Effect.die`)

The split is mechanical: **does the fake own a resource that needs teardown?**

**`Layer.succeed(Tag, Tag.make({...}))`** — no resource, just data + functions:

```ts
// extension/src/__mocks__/TestSentry.ts:8
export const TestSentryLive = Layer.succeed(Sentry, Sentry.make({
  addBreadcrumb: () => Effect.void,
  captureException: () => Effect.void,
  captureMessage: () => Effect.void,
  errorLogger: Logger.none,
  setContext: () => Effect.void,
  setTag: () => Effect.void,
}));
```

Same shape: `TestTelemetry.ts:8`, `TestExtensionContext.ts:28`. Inline `Layer.succeed(LanguageClient, LanguageClient.make({...}))` inside a `withTestCtx` fixture (`CellStateManager.test.ts:23`) is the variant when you need to capture commands into a per-test `Ref`.

**`Layer.scoped(Tag, Effect.gen(...))`** — fake owns a resource (subprocess, file handle, subscription). Canonical: `TestLanguageClient.ts:13` spawns the real `marimo-lsp` subprocess via `Effect.acquireRelease`:

```ts
export const TestLanguageClientLive = Layer.scoped(LanguageClient,
  Effect.gen(function*() {
    const { conn } = yield* Effect.acquireRelease(
      Effect.gen(function*() { /* spawn, initialize */ return { conn, proc }; }),
      ({ conn, proc }) => Effect.sync(() => { conn.dispose(); proc.kill(); }),
    );
    return LanguageClient.make({ /* executeCommand → conn.sendRequest, ... */ });
  }),
);
```

**Unused methods**: `Effect.die("not implemented")` — silent `undefined` returns hide boundary violations. For non-Effect synchronous methods on a stub like `TestVsCode.ts:931,1039`, `throw new Error("not implemented")` does the same.

## Error handling

Use `Effect.either` to convert a failing Effect into `Either<E, A>`, then narrow with `Either.isLeft`/`isRight` + `_tag` checks:

```ts
// extension/src/python/__tests__/Uv.test.ts:64
const result = yield* Effect.either(uv.addProject({ directory: tmpdir.path, packages: ["httpx"] }));
assert(Either.isLeft(result), "Expected failure");
assert.strictEqual(result.left._tag, "UvMissingPyProjectError");
```

For diagnostics-bearing errors, snapshot the payload after the tag check (`EnvironmentValidator.test.ts:72-84`). Avoid `expect(...).rejects` — it gives you the unwrapped cause, but loses Effect's typed-error shape; `Effect.either` keeps the `_tag` discriminant.

## What to avoid

- **`{} as FooService`** — fully `implements`. (Philosophy in `CLAUDE.md`.) `Effect.die("not implemented")` for stubs you don't expect to hit.
- **`Effect.runPromise(...)` inside a test body** — use `it.effect`/`it.scoped` and `yield*`. `runPromise` uses the live clock and live services.
- **`vi.useFakeTimers()`** — use `TestClock.adjust`. `it.effect` already swaps in a virtual clock Effect's scheduler understands; layering vitest's fake timers on top breaks both.
- **`await new Promise(r => setTimeout(r, 50))`** — `yield* TestClock.adjust("50 millis")`. Wall-time waits are flaky under CI load.
- **Publish/offer and immediately assert** — yield with `TestClock.adjust("1 millis")` so the subscriber fiber actually runs. Publish is synchronous; observation is not.
- **One `it.layer` around the file when each test needs an independent `Ref`/`Queue`/`PubSub`** — use a `withTestCtx` fixture that returns fresh per-test state.
- **Forgetting `Effect.fork` before a long `sleep`/`timeout`** — the test fiber blocks and never reaches `TestClock.adjust` (`TestClock.ts:67-73`).
