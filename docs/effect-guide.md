# Effect guide

How we write Effect code in `extension/src`. This guide follows the
[OpenCode Effect guide](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/specs/effect/guide.md),
adapted to this extension.

Use this shape for new work and migrate legacy code only when it is in scope.

## Service shape

Use one module per service: flat exports, traced Effect methods, and an explicit
layer.

```ts
export interface Interface {
  readonly get: (id: ItemId) => Effect.Effect<Item, NotFoundError>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/ItemStore",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const dependency = yield* Dependency.Service;

    const get = Effect.fn("ItemStore.get")(function* (id: ItemId) {
      return yield* dependency.load(id);
    });

    return Service.of({ get });
  }),
);
```

Consumers import the module as a standard ESM namespace:

```ts
import * as ItemStore from "./ItemStore.ts";

const items = yield* ItemStore.Service;
yield* items.get(id);
```

Rules:

- Keep `Interface` small and based on caller intent.
- Keep `Service` free of construction and behavior.
- Prefix context identities with `@marimo/`.
- Return `Service.of({...})` from the implementation.
- Define public methods as local
  `Effect.fn("Module.method")(function* (...) { ... })` values and pass them to
  `Service.of` by shorthand.
- Use `Effect.fnUntraced` for small internal helpers.
- Keep helpers private and at module scope.

## Layer composition

- Export an open `layer`; compose production dependencies in
  `features/Main.ts` and `extension.ts`.
- Use `Layer.mergeAll(...)` for peers and `Layer.provide([...])` for dependency
  levels.
- Use `Layer.provideMerge(...)` only when the provided output must remain
  visible.
- Use `Layer.effectDiscard` for scoped activation modules that produce no
  service value.
- Prefer Effect's built-in operators. Add no custom layer graph until recurring
  graph problems require one.

Modules that only install scoped behavior export a layer and no service:

```ts
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const dependency = yield* Dependency.Service;
    yield* dependency.register(/* ... */);
  }),
);
```

Import these modules as ESM namespaces and compose `Module.layer`.

## Runtime boundaries

Most code runs through the application `ManagedRuntime` created in
`features/Main.ts`. Avoid service-local runtimes.

At VS Code and language-client callback boundaries, capture the current context
with `Effect.runPromiseWith` or `Effect.runForkWith`. Domain code returns
effects while adapters run them.

## Notebook session state

State shared by the extension belongs to the application layer. State and
resources owned by one notebook belong to `NotebookSessionResources`.

Keep subscriptions, finalizers, and background work in the owning scope. Use
`Effect.acquireRelease`, `Effect.addFinalizer`, and `Effect.forkScoped`. The
caller controls concurrency; do not expose partially initialized state.

When a caller can publish immediately after construction, acquire the required
subscription before returning the layer. Prefer a scoped Effect that returns a
buffered stream, as in `subscribeNotebookLifecycle`. Starting a consumer with
`startImmediately` does not guarantee that asynchronous stream setup has
finished. Acquire first, then fork the consumer.

## Errors

Expected failures belong on the Effect error channel. Defects are for violated
invariants and final unknown-cause fallbacks.

- Define errors beside the module that gives them meaning.
- Keep exported class names concise for namespace use, such as
  `ItemStore.NotFoundError`.
- Qualify error tags with the module name, such as `"ItemStore.NotFoundError"`.
- Export an `Error` union when a service has several expected failures.
- Use `Schema.TaggedError` for encoded errors and `Data.TaggedError` for
  internal errors. This is the installed Effect version's equivalent of
  OpenCode's `Schema.TaggedErrorClass`.
- Translate external failures with `Effect.try`, `Effect.tryPromise`, or
  `Effect.mapError`.
- Translate domain errors into UI messages, diagnostics, or telemetry at the
  outer adapter.

## Schemas

Use Effect Schema as the source of truth for encoded, persisted, and protocol
data. Prefer `Schema.Class` for exported data, `Schema.Struct` for structural
data, and branded schemas or existing branded types for identifiers.

## Preferred services

Inside Effect code, yield existing services instead of using platform APIs
directly. Prefer `VsCode`, `Storage`, `PythonExtension`, and the language-server
services. Keep VS Code, Node, JSON-RPC, and generated-model conversions in
narrow adapters.

## Logging and tracing

- Use Effect's logging primitives.
- Put variable data in `Effect.annotateLogs`, not the message.
- Use `Effect.annotateCurrentSpan` for context on the current span.
- Use `Effect.withSpan` for important operations that are not already wrapped
  in a named `Effect.fn`.

## Testing

Tests live in `extension/tests` and mirror `extension/src` one level deep.
Beside the mirror, `tests/fake` holds fakes of external boundaries,
`tests/lib` holds the runner and shared helpers, `tests/fixtures` holds
data, and `tests/vscode` holds the extension-host suite. Read a neighbouring
test for the conventions; the rules below are the ones a test file cannot show.

- Fake only external boundaries: VS Code, the marimo language server, the
  Python extension, telemetry. Everything else runs the production layer. A
  fake earns a module under `tests/fake` when it has a second consumer.
- Observe through the fakes. Do not add observation ports to production
  services for tests; if a fake cannot see a behavior, extend the fake.
- Per-test state that a fake must see is created inside
  `Layer.unwrap(Effect.gen(...))` and exposed through a test-local
  `Context.Service` in the same file. `EffectTest.make` rebuilds the layer
  for every test, so that is the only place such state can live.
- Use `it.live` only when the behavior depends on the live clock, filesystem,
  processes, watchers, or servers.

## Verification

From the repository root:

```sh
just lint-ts
just test-ts
```
