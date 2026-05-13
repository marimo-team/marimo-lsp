# Effect — core patterns

## TL;DR

Write straight-line effectful code with `Effect.gen` + `yield*`; wrap the **entry point** of any meaningful operation in `Effect.fn("namespace.operation")(function*() { ... })` for a span + captured stack trace. The three type parameters of `Effect<A, E, R>` are: **A** = success, **E** = typed failure, **R** = required services. Errors outside `E` are *defects* — bugs — surfaced as `Cause.Die`; never `throw` to fast-fail. At callback boundaries, capture the runtime once (`yield* Effect.runtime()`) and use `Runtime.run*` to dispatch back into Effect.

## Constructors & combinators

The 80/20 surface. Citations refer to `repos/effect/packages/effect/src/Effect.ts`.

```ts
// --- Lifting values / generator entry points ---
Effect.succeed(42) / Effect.fail(new MyErr())                      (:3160/:2575)
Effect.sync(() => readSync()) / Effect.promise(() => fetch(url))   (:3326/:3131)
Effect.tryPromise({ try, catch })   // map rejection → typed E     (:4677)
Effect.gen(function* () { ... })                    // inline; no span         (:2760)
Effect.fn("module.op")(function* (args) { ... })   // span + stack capture    (:14624)
Effect.fnUntraced(function* (args) { ... })         // no span; for hot cbs   (:14759)

// --- Transform / error channel ---
Effect.map / flatMap / andThen / tap / as / asVoid                 (:5170+)
Effect.catchTag("MyErr", (e) => fallback)                          (:3882)
Effect.catchTags({ A: …, B: … }) / catchAll / catchAllCause        (:3948/:3472/:3518)
Effect.mapError((e) => newErr) / orElse(() => other)               (:5310/:11354)

// --- Concurrency / fibers / time ---
Effect.all([a,b,c], { concurrency: 3 })                            (:825)
Effect.forEach(xs, (x) => eff, { concurrency })                    (:1605)
Effect.fork / forkScoped / scoped                                  (:6283/:6506/:6053)
Effect.sleep("500 millis") / Effect.retry(self, schedule)          (:6903/:4400)

// --- Tracing & logging ---
Effect.withSpan("name", { attributes })                            (:13099)
Effect.annotateCurrentSpan("key", v) / Effect.annotateLogs({ … })  (:12990/:11072)
Effect.log / logDebug / logInfo / logWarning / logError            (:10850+)
```

## Bridging callbacks: `Effect.runtime` + `Runtime.run*`

VS Code, `vscode-languageclient`, and Node all hand you event-callbacks that return `void` or `Promise<void>`. To dispatch Effect-typed work from them, capture the **current runtime** (carrying all `R` services, logger, and scope) once at construction and use `Runtime.runPromise` / `runFork` / `runSync`:

```ts
// extension/src/platform/VsCode.ts:54
const runSync = Runtime.runSync(yield* Effect.runtime());
api.onDidChangeActiveColorTheme((theme) => {
  runSync(SubscriptionRef.set(colorThemeRef, resolve(theme.kind)));
});

// extension/src/lsp/client.ts:279
const runFork = Runtime.runFork(yield* Effect.runtime());
conn.onRequest(lsp.RegistrationRequest.method, (params) => {
  runFork(SubscriptionRef.update(ref, (regs) => /* … */));
});
```

`runFork` for fire-and-forget, `runPromise` when the host needs a `Promise`, `runSync` only for pure-sync `Ref` updates. Never call `Effect.runPromise` inline inside a service — that spins up a *fresh* default runtime, severing scope, telemetry, and service context.

## Fiber lifecycle: `forkScoped` and structured concurrency

`Effect.forkScoped` ties a fiber to the **enclosing `Scope`**: when the scope closes (layer release, `Effect.scoped` block exit), the fiber is interrupted and all finalizers run. This is the right primitive for "subscribe to a stream / pump a queue for the lifetime of this service":

```ts
// extension/src/kernel/KernelManager.ts:93
yield* Effect.forkScoped(
  Effect.gen(function* () {
    while (true) {
      const msg = yield* Queue.take(queue);
      yield* processOperation(msg, scratchOps).pipe(
        Effect.annotateLogs({ notebookUri: msg.notebookUri, operation: msg.operation.op }),
        Effect.withSpan("process-operation"),
        Effect.catchAllCause(Effect.fn(function* (cause) {
          yield* Effect.logError("Failed to process marimo operation")
            .pipe(Effect.annotateLogs({ cause }));
        })),
      );
    }
  }),
);
```

Rules of thumb: `Effect.fork` for ad-hoc fibers you'll `Fiber.join` / `Fiber.interrupt` yourself; `Effect.forkScoped` inside `Layer.scopedDiscard` / `Effect.Service` for auto cleanup. A long-running stream consumer must `Stream.runDrain` *inside* a `forkScoped`, never run synchronously (that would block layer construction forever).

## Observability: `Effect.fn`, `withSpan`, annotations

Three tools, layered:

- `Effect.fn("namespace.op")(function* … )` — top-level entry point; names a span and captures a JS stack at call site so async traces stay readable. The wrapper also converts thrown JS errors in the body or pipeline into typed `Cause.Die` (fn.test.ts:9).
- `Effect.fnUntraced(function* … )` — same shape, no span. Use for inner callbacks invoked in hot paths (`Stream.mapEffect` body, JSON-RPC notification handlers) where a per-call span would be noise.
- `Effect.withSpan("verb.target", { attributes })` — wrap *external* I/O (LSP request, subprocess exec). Variable data goes into `attributes`, never the span name.
- `Effect.annotateLogs({ key: value })` — structured log fields. Always prefer to interpolating into the message string — log indexers can filter on fields but not substrings.
- `Effect.annotateCurrentSpan("key", value)` — late-bound span attribute, e.g. after a fetch returns and you know the response status.

## Worked examples (from this repo)

**Entry-point with span + structured error** (`extension/src/lsp/LanguageClient.ts:199`)

```ts
executeCommand: Effect.fn(function* (cmd: MarimoCommand) {
  return yield* Effect.tryPromise({
    try: (signal) => client.sendRequest("workspace/executeCommand",
      { command: cmd.command, arguments: [cmd.params] }, tokenFromSignal(signal)),
    catch: (cause) => new ExecuteCommandError({ command: cmd, cause }),
  }).pipe(
    Effect.withSpan("lsp.executeCommand", {
      attributes: { command: cmd.command, method: extractMethod(cmd) },
    }),
  );
}),
```

The dynamic `command` value goes on the span; the rejection is mapped to a typed `ExecuteCommandError`.

**`forkScoped` + `Stream.mapEffect` + `Effect.fn` per event** (`extension/src/features/ThemeSync.ts:20`)

```ts
yield* Effect.forkScoped(
  Stream.zipLatest(code.window.colorThemeChanges().pipe(Stream.changes),
                   editorRegistry.streamActiveNotebookChanges()).pipe(
    Stream.mapEffect(Effect.fn("ThemeSync.sync")(function* ([theme]) {
      yield* client.executeCommand({ command: "marimo.api",
        params: { method: "set-display-theme", params: { theme } },
      }).pipe(Effect.catchAll(Effect.fn(function* (error) {
        yield* Effect.logWarning("Failed to sync theme")
          .pipe(Effect.annotateLogs({ error }));
      })));
    })),
    Stream.runDrain,
  ),
);
```

**`catchTag` chain for tag-narrowed recovery** (`extension/src/python/Uv.ts:233`)

```ts
return uv({ args: ["tree", "--script", options.script, "-d", "0", "--quiet"] }).pipe(
  Effect.catchTag("UvUnknownError", UvResolutionError.refine.bind(null)),
  Effect.catchTag("UvUnknownError",
    UvMissingPep723MetadataError.refine.bind(null, options.script)),
  Effect.map((e) => e.stdout),
);
```

## Worked examples (from Effect itself)

**`Effect.fn` catches defects in body *and* pipeline into a sequential cause**
(`repos/effect/packages/effect/test/Effect/fn.test.ts:45`)

```ts
const fn = Effect.fn("test")(
  (): Effect.Effect<void> => { throw new Error("test")  },
  (_): Effect.Effect<void> => { throw new Error("test2") },
);
const cause = yield* fn().pipe(Effect.sandbox, Effect.flip);
// cause is Cause.Sequential(Die("test"), Die("test2"))
```

**`Effect.fork` propagates interruption — the basis of structured concurrency**
(`repos/effect/packages/effect/test/Effect/forking.test.ts:13`)

```ts
const result = yield* pipe(Effect.never, Effect.fork, Effect.flatMap(Fiber.interrupt));
assertTrue(Exit.isInterrupted(result));
```

Interrupting the parent fiber (or its scope) cascades to children — exactly what `forkScoped` relies on.

## Error handling

Define typed errors as `Data.TaggedError` so `catchTag` can narrow by `_tag`:

```ts
class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly path: string;
}> {}

const program = readFile(path).pipe(
  Effect.catchTag("NotFoundError", (e) =>
    Effect.logWarning("File missing")
      .pipe(Effect.annotateLogs({ path: e.path }), Effect.as(""))),
);
```

Recovery widens left to right: `catchTag` → `catchTags` → `orElse` → `catchAll` → `catchAllCause` (also defects). Use `catchAllCause` at fiber boundaries (`forkScoped` / `Stream.mapEffect` body), where an uncaught defect would crash the fiber silently. Reach for `Effect.either` only when you genuinely need both branches in the success channel.

## What to avoid

- **Don't** `Effect.fn(function* () { ... })` anonymous at the top level — **do** `Effect.fn("module.operation")(function* () { ... })`. Without a name, traces show `<anonymous>` and the span isn't grep-able. For hot inner callbacks, prefer `Effect.fnUntraced` to skip per-call span overhead.

- **Don't** interpolate variable data into log messages, e.g. ``Effect.logDebug(`path: ${env.path}`)`` — **do** `Effect.logDebug("Python interpreter resolved").pipe(Effect.annotateLogs({ path: env.path }))`. Interpolated strings cardinality-explode in log search and can't join with span attributes.

- **Don't** call `Effect.runPromise` deep inside a service — **do** capture `Runtime.runPromise(yield* Effect.runtime())` at construction and reuse it. A fresh `runPromise` runs against the default runtime, losing scope, services, and tracing context.

- **Don't** reach for `Effect.either(self)` to "see if it failed" — **do** narrow with `Effect.catchTag(...)`. `either` collapses every error into the success channel; `catchTag` preserves the rest of `E` and the compiler checks exhaustiveness.

- **Don't** `throw` inside an `Effect.gen` body to bail out — **do** `yield* Effect.fail(new MyTaggedError({ ... }))`. `throw` becomes an opaque `Cause.Die` no `catchTag` will see; a typed failure is visible in `Effect<A, E, R>` and the compiler forces callers to handle it.

- **Don't** swallow errors with bare `Effect.catchAll(() => Effect.void)` — **do** at minimum `Effect.catchAllCause((cause) => Effect.logWarning("…").pipe(Effect.annotateLogs({ cause })))`. The `cause` annotation preserves the full trace.

- **Don't** use `as T` to satisfy a return type — **do** narrow via `Schema`, a type guard, or `assert(...)`. If a cast is truly unavoidable, leave a `// SAFETY:` comment naming the invariant you're staking, just like Rust `unsafe`.
