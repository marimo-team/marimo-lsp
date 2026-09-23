# Effect migration TODO

Track the migration defined in [effect-guide.md](effect-guide.md). Keep each
service migration in its own commit and update this inventory when the source
tree changes.

Audit commands:

```sh
rg -n --glob '*.ts' 'Context\.Service' extension/src
rg -n --glob '*.ts' 'static readonly layer' extension/src
rg -l --glob '*.ts' 'Layer\.effectDiscard' extension/src
rg -n --glob '*.ts' 'ManagedRuntime\.make' extension/src
```

## Pilot services

- [ ] `platform/OutputChannel.ts`
- [ ] `python/PythonEnvInvalidation.ts`
- [ ] `notebook/NotebookRenderer.ts`

## Service modules

### Configuration

- [ ] `config/Config.ts`
- [ ] `config/NotebookConfiguration.ts`

### Kernel

- [ ] `kernel/CellExecutions.ts`
- [ ] `kernel/CellOutputProjections.ts`
- [ ] `kernel/DebugAdapter.ts`
- [ ] `kernel/NotebookRuntime.ts`
- [ ] `kernel/VsCodeCellDrive.ts`
- [ ] `kernel/VsCodeNotebookOutputPresenter.ts`

### Language servers

- [ ] `lsp/MarimoClient.ts`
- [ ] `lsp/RuffLanguageServer.ts`
- [ ] `lsp/TyLanguageServer.ts`

### Notebook

- [ ] `notebook/CellMetadataUIBindingService.ts`
- [ ] `notebook/NotebookDependencies.ts`
- [ ] `notebook/NotebookDocumentSessions.ts`
- [ ] `notebook/NotebookEditorRegistry.ts`
- [ ] `notebook/NotebookSerializer.ts`
- [ ] `notebook/NotebookSessionResources.ts`

### Panels

- [ ] `panel/TreeView.ts`
- [ ] `panel/datasources/NotebookDatasources.ts`
- [ ] `panel/sessions/LiveSessions.ts`
- [ ] `panel/variables/NotebookVariables.ts`

### Platform

- [ ] `platform/Api.ts`
- [ ] `platform/Constants.ts`
- [ ] `platform/GitHubClient.ts`
- [ ] `platform/Storage.ts`
- [ ] `platform/VsCode.ts`: `Window`
- [ ] `platform/VsCode.ts`: `Commands`
- [ ] `platform/VsCode.ts`: `Workspace`
- [ ] `platform/VsCode.ts`: `Env`
- [ ] `platform/VsCode.ts`: `Debug`
- [ ] `platform/VsCode.ts`: `Notebooks`
- [ ] `platform/VsCode.ts`: `Auth`
- [ ] `platform/VsCode.ts`: `Languages`
- [ ] `platform/VsCode.ts`: `VsCode`

### Python

- [ ] `python/EnvironmentValidator.ts`
- [ ] `python/PythonExtension.ts`
- [ ] `python/Uv.ts`

### Status and telemetry

- [ ] `statusbar/StatusBar.ts`
- [ ] `telemetry/HealthService.ts`
- [ ] `telemetry/Telemetry.ts`

## Context-only services

Review these tags for explicit interfaces, `@marimo/` identities, and namespace
imports. They do not need construction layers.

- [ ] `notebook/NotebookSession.ts`
- [ ] `platform/Storage.ts`: `ExtensionContext`

## Activation layers

Keep these as `Layer.effectDiscard` modules and verify their resources end with
the layer scope. Export `layer`, import the module as a namespace, and remove
`Live` suffixes.

- [ ] `config/ConfigContextManager.ts`
- [ ] `features/AutoExport.ts`
- [ ] `features/CellInputVisibilitySync.ts`
- [ ] `features/CellMetadataBindings.ts`
- [ ] `features/CellStatusBarProvider.ts`
- [ ] `features/DebugLayer.ts`
- [ ] `features/MarimoCodeLensProvider.ts`
- [ ] `features/MarimoFileDetector.ts`
- [ ] `features/RegisterCommands.ts`
- [ ] `features/RegisterLanguageModelTools.ts`
- [ ] `features/ReloadOnConfigChange.ts`
- [ ] `features/ThemeSync.ts`
- [ ] `kernel/NotebookControllers.ts`
- [ ] `panel/datasources/DatasourcesView.ts`
- [ ] `panel/packages/PackagesView.ts`
- [ ] `panel/sessions/SessionFileLifecycle.ts`
- [ ] `panel/sessions/SessionsView.ts`
- [ ] `panel/variables/VariablesView.ts`
- [ ] `statusbar/MarimoStatusBar.ts`
- [ ] `statusbar/PythonEnvironmentStatusBar.ts`

## Composition

- [ ] Replace repeated activation merges in `features/Main.ts` with a named
  `Layer.mergeAll(...)` group.
- [ ] Group `Layer.provide([...])` calls by dependency level.
- [ ] Preserve `Layer.provideMerge(...)` where the service must remain in the
  runtime output.
- [ ] Reconsider a graph abstraction only if built-in operators leave recurring
  ordering, cycle, multi-root, or replacement problems.

## Test harness migration

Migrate the existing tests to Effect-aware runners and fixtures without
removing, combining, or weakening test cases. Preserve test names and
behavioral assertions. A checked suite means its harness and dependency setup
were reviewed; a local `Effect.provide` may remain when it is the clearest way
to express a one-test dependency variant.

Baseline from 2026-09-23:

- 77 test files import `@effect/vitest`.
- 59 test files contain `Effect.provide`.
- 5 test files contain `it.layer`.
- `kernel/__tests__/imageResolver.test.ts` runs Effects from ordinary async
  tests with `Effect.runPromise`.
- `wasm/__tests__/Processes.test.ts` coordinates an Effect test with
  `Promise.withResolvers`.

Refresh the inventory with:

```sh
rg -l --glob '*test.ts' 'from "@effect/vitest"' extension/src
rg -l --glob '*test.ts' 'Effect\.provide\(' extension/src
rg -l --glob '*test.ts' 'it\.layer\(' extension/src
rg -n --glob '*test.ts' \
  'Effect\.runPromise|Promise\.withResolvers|setTimeout\(' extension/src
```

### Migration rules

- [x] Record the runner, isolation, and partial-mock rules in
  `docs/effect-guide.md`.
- [ ] Preserve every existing test case, test name, and behavioral assertion
  during harness migration.
- [ ] Use `it.effect` for deterministic Effect tests and `it.live` only for
  deliberate live clock, filesystem, process, watcher, or server behavior.
- [ ] Use a suite-level `it.layer` only when sharing the layer's state and scope
  across that suite is safe and intentional.
- [ ] Give stateful resources a fresh instance per test. Use a one-test
  `it.layer(Layer.fresh(...))` block or construct and provide the layer inside
  the test.
- [ ] Compose replacement dependencies from open layers. Do not build a closed
  default layer and then attempt to override one of its internal services.
- [ ] Keep special one-test dependency variants local instead of forcing every
  provider into a shared suite layer.
- [ ] Prefer `Deferred`, queues, events, or observable state transitions over
  promises, sleeps, polling, and arbitrary timeouts.
- [x] Add shared test helpers only after at least two migrated suites establish
  the same missing abstraction.
- [x] Add `EffectTest.make(layer)` after the `TestVsCode` contract tests and
  `NotebookEditorRegistry` pilot both needed a fresh layer for each test.
- [x] Extend `EffectTest.make` with `each` when a migrated suite first needs it.
- [ ] Add other runner modifiers such as `skipIf` only when a migrated suite
  first needs them.

### `TestVsCode` model and test service

`TestVsCode` is a stateful in-memory adapter used by 64 test files. Keep that
capability, but separate its model, production adapter, and test-control
interface. Migrate it incrementally so existing suites continue to compile.

- [ ] Preserve and extend `__tests__/TestVsCode.test.ts` as contract coverage
  for editor snapshots, document lifecycle ordering, registrations, command
  recording, renderer messaging, and disposal.
- [ ] Introduce one private model for mutable VS Code state. Keep its `Ref`,
  `SubscriptionRef`, `Queue`, `Deferred`, and `PubSub` values private and expose
  immutable snapshots and named transitions.
- [x] Remove the module-global closed-document registry; each fixture document
  owns its lifecycle flag.
- [ ] Make model transitions preserve cross-namespace invariants atomically:
  activating an editor makes it visible, opening and closing a document update
  the workspace snapshot and lifecycle stream together, and disposal removes
  registrations.
- [x] Define a `TestVsCode.Service` control interface with domain operations
  such as `openNotebook`, `closeNotebook`, `setActiveNotebookEditor`,
  `selectNotebookController`, and renderer message exchange.
- [x] Put observations on the control interface as Effects returning immutable
  values: `snapshot`, executed commands, affinity updates, registered
  controllers, serializers, views, and status-bar providers. Do not expose raw
  mutable refs or pub/sub handles to test files.
- [x] Build one layer that provides both `VsCode.Service` and
  `TestVsCode.Service` from the same private model. Tests yield the control
  service; production modules continue to yield `VsCode.Service`.
- [x] Construct that stateful layer once per test. Do not share one
  `TestVsCode` model across an `it.layer` block containing multiple tests.
- [ ] Separate initial model data from behavior scripting. Keep options such as
  initial documents, installed extensions, version, and filesystem contents as
  layer inputs; move prompt responses and other interactions toward named
  queues or control operations instead of broad `Partial<Window.Interface>`,
  `Partial<Workspace.Interface>`, and `Partial<Commands.Interface>` overrides.
- [x] Keep temporary compatibility for `TestVsCode.make()` and existing
  factory exports while migrating callers. Remove the `{ layer, raw refs }`
  facade only after its consumers use `TestVsCode.Service` observations.
- [ ] After the model interface is proven, move VS Code value implementations
  and factories such as `Uri`, `NotebookDocument`, `NotebookEditor`, and
  `WorkspaceEdit` into a value-fixture module with compatibility re-exports
  from `TestVsCode.ts`.
- [x] Pilot the new layer in `notebook/__tests__/NotebookEditorRegistry.test.ts`
  and `__tests__/extension.test.ts`, covering both focused lifecycle behavior
  and full extension composition before migrating the kernel suites.
- [ ] Split smaller platform fakes from the full model when a suite needs only
  one narrow seam; do not require every test importing a VS Code value fixture
  to build the full `TestVsCode` layer.

### Partial mocks

Use `Layer.mock` only when omitted effectful operations represent unexpected
dependencies. Use complete, explicit fakes when no-op behavior, state, call
recording, or reusable inspection controls are part of the test contract.

- [x] Keep the existing narrow `Uv.Service` mock in
  `kernel/__tests__/operations.test.ts`.
- [x] Replace the unused `StatusBar.Service.createSimpleStatusBarItem` defect in
  `statusbar/__tests__/PythonEnvironmentStatusBar.test.ts` with omission from a
  partial mock.
- [x] Give `commands/__tests__/refreshPackages.test.ts` only the
  `NotebookEditorRegistry.Service.getActiveNotebookUri` operation it exercises.
- [x] Keep only the required `notebookType` value in the partial
  `NotebookSerializer.Service` used by
  `commands/__tests__/showNotebookMenu.test.ts`.
- [x] Omit the unused `PythonEnvInvalidation.Service.changes` stream in
  `kernel/__tests__/operations.test.ts`; restore a complete fake if the stream
  becomes part of the scenario.
- [x] Keep `TestVsCode`, `TestTelemetryLive`, `TestPythonExtension`, and
  `TestNotebookRuntime` as explicit reusable fakes rather than partial
  mocks.

### Pilot migrations

- [x] Migrate `platform/__tests__/Storage.test.ts` to establish the per-test
  state-isolation pattern.
- [x] Migrate `kernel/__tests__/imageResolver.test.ts` from ordinary async tests
  and `Effect.runPromise` to `it.effect`; replace global `fetch` stubs with an
  explicit Effect `HttpClient` test layer.
- [x] Migrate `commands/__tests__/refreshPackages.test.ts` as the first narrow
  `Layer.mock` example.
- [x] Migrate `wasm/__tests__/Processes.test.ts` to Effect-native process
  coordination, using `it.live` only for the actual process boundary.
- [x] Review the pilots before broad migration and keep the custom
  `EffectTest` runner limited to fresh per-test layer provisioning.

### Suite inventory

#### Test infrastructure

- [x] `__tests__/TestVsCode.test.ts`
- [x] `__tests__/extension.test.ts`

#### Commands

- [x] `commands/__tests__/CommandDefinitions.test.ts`
- [x] `commands/__tests__/configureAutoExport.test.ts`
- [x] `commands/__tests__/openAsMarimoNotebook.test.ts`
- [x] `commands/__tests__/openOutlineView.test.ts`
- [x] `commands/__tests__/refreshPackages.test.ts`
- [x] `commands/__tests__/restartKernel.test.ts`
- [x] `commands/__tests__/sessionCommands.test.ts`
- [x] `commands/__tests__/setCellCodeVisibility.test.ts`
- [x] `commands/__tests__/setCellDisabled.test.ts`
- [x] `commands/__tests__/showNotebookMenu.test.ts`

#### Configuration

- [x] `config/__tests__/Config.test.ts` — keeps the no-VS-Code fallback layer
  local to the test that exercises it.
- [x] `config/__tests__/NotebookConfiguration.test.ts`

#### Features

- [x] `features/__tests__/AutoExport.test.ts`
- [x] `features/__tests__/CellInputVisibilitySync.test.ts`
- [x] `features/__tests__/CellMetadataBindings.test.ts`
- [x] `features/__tests__/CellStatusBarProvider.test.ts`
- [x] `features/__tests__/Logger.test.ts` — keeps per-test logger layers local.
- [x] `features/__tests__/MarimoCodeLensProvider.test.ts`
- [x] `features/__tests__/MarimoFileDetector.test.ts`
- [x] `features/__tests__/RegisterLanguageModelTools.test.ts`
- [x] `features/__tests__/ReloadOnConfigChange.test.ts`
- [x] `features/__tests__/ThemeSync.test.ts`

#### Kernel

- [x] `kernel/__tests__/CellExecutions.test.ts`
- [x] `kernel/__tests__/CellOutputProjection.test.ts`
- [x] `kernel/__tests__/NotebookControllers.test.ts`
- [x] `kernel/__tests__/NotebookRuntime.test.ts`
- [x] `kernel/__tests__/NotebookRuntimeOperations.test.ts`
- [x] `kernel/__tests__/VsCodeCellDrive.test.ts`
- [x] `kernel/__tests__/VsCodeNotebookOutputPresenter.test.ts`
- [x] `kernel/__tests__/imageResolver.test.ts`
- [x] `kernel/__tests__/operations.test.ts`

#### Library boundaries

- [x] `lib/__tests__/binaryResolution.test.ts` — keeps captured logger layers
  local to the assertions that inspect them.
- [x] `lib/__tests__/dap-proxy.test.ts`
- [x] `lib/__tests__/extractExecuteCodeRequest.test.ts`
- [x] `lib/__tests__/getCellExecutableCode.test.ts`
- [x] `lib/__tests__/getTopologicalCells.test.ts`
- [x] `lib/__tests__/installPackages.test.ts`
- [x] `lib/__tests__/openExternalUrl.test.ts`

#### Language servers

- [ ] `lsp/__tests__/MarimoClient.test.ts`
- [ ] `lsp/__tests__/TyLanguageServer.test.ts`
- [x] `lsp/__tests__/client.integration.test.ts`
- [x] `lsp/__tests__/clientCleanup.test.ts` — keeps per-test logger layers local.
- [x] `lsp/__tests__/connect.test.ts`
- [ ] `lsp/__tests__/converters.test.ts`

#### Notebook

- [ ] `notebook/__tests__/CellMetadata.test.ts`
- [x] `notebook/__tests__/CellMetadataUIBinding.test.ts`
- [ ] `notebook/__tests__/NotebookDependencies.test.ts`
- [ ] `notebook/__tests__/NotebookDocumentSessions.test.ts`
- [x] `notebook/__tests__/NotebookEditorRegistry.test.ts`
- [ ] `notebook/__tests__/NotebookSerializer.test.ts`
- [x] `notebook/__tests__/NotebookSessionResources.test.ts`

#### Panels

- [ ] `panel/datasources/__tests__/NotebookDatasources.test.ts`
- [ ] `panel/sessions/__tests__/LiveSessions.test.ts`
- [ ] `panel/variables/__tests__/NotebookVariables.test.ts`

#### Platform

- [x] `platform/__tests__/Api.test.ts`
- [x] `platform/__tests__/Commands.test.ts` — keeps its captured logger layer
  local to the logging test.
- [x] `platform/__tests__/Storage.test.ts`

#### Status and telemetry

- [x] `statusbar/__tests__/PythonEnvironmentStatusBar.test.ts`
- [x] `telemetry/__tests__/Telemetry.test.ts`

#### Wasm

- [x] `wasm/__tests__/Processes.test.ts`

### Migration order

- [x] Complete and review the pilot migrations.
- [x] Migrate the kernel suites, starting with smaller fixtures before
  `CellExecutions.test.ts` and `NotebookRuntime.test.ts`.
- [ ] Migrate configuration, feature, and command suites.
- [ ] Migrate notebook, panel, and language-server suites.
- [ ] Migrate platform and library-boundary suites.
- [ ] Re-run the inventory and review any remaining local `Effect.provide` calls
  as intentional dependency variants.

### Validation

- [x] Run each migrated file with `just test-ts <path-from-extension>` while
  iterating.
- [x] Confirm test names and test counts are unchanged in each migration PR.
- [x] Run `just lint-ts` and `just test-ts` before completing each migration PR.
- [x] Run `just test-vscode` when a migration touches activation or observable
  VS Code behavior.
- [ ] Keep `ManagedRuntime.make` at the application root or in tests.
- [ ] Add checks for `@marimo/` identities and production `static readonly
  layer` fields after the service migration settles.
