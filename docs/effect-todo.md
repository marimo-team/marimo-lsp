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

- [x] `platform/OutputChannel.ts`
- [x] `python/PythonEnvInvalidation.ts`
- [x] `notebook/NotebookRenderer.ts`

## Service modules

### Configuration

- [x] `config/Config.ts`
- [x] `config/NotebookConfiguration.ts`

### Kernel

- [x] `kernel/CellExecutions.ts`
- [x] `kernel/CellOutputProjections.ts`
- [x] `kernel/DebugAdapter.ts`
- [x] `kernel/NotebookRuntime.ts`
- [x] `kernel/VsCodeCellDrive.ts`
- [x] `kernel/VsCodeNotebookOutputPresenter.ts`

### Language servers

- [x] `lsp/MarimoClient.ts`
- [x] `lsp/RuffLanguageServer.ts`
- [x] `lsp/TyLanguageServer.ts`

### Notebook

- [x] `notebook/CellMetadataUIBinding.ts`
- [x] `notebook/NotebookDependencies.ts`
- [x] `notebook/NotebookDocumentSessions.ts`
- [x] `notebook/NotebookEditorRegistry.ts`
- [x] `notebook/NotebookSerializer.ts`
- [x] `notebook/NotebookSessionResources.ts`

### Panels

- [x] `panel/TreeView.ts`
- [x] `panel/datasources/NotebookDatasources.ts`
- [x] `panel/sessions/LiveSessions.ts`
- [x] `panel/variables/NotebookVariables.ts`

### Platform

- [x] `platform/Api.ts`
- [x] `platform/Constants.ts`
- [x] `platform/GitHubClient.ts`
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

## Tests and enforcement

- [ ] Classify `extension/src/__mocks__` as shared adapters, configurable
  factories, or test-local stubs.
- [ ] Keep `ManagedRuntime.make` at the application root or in tests.
- [ ] Add checks for `@marimo/` identities and production `static readonly
  layer` fields after the migration settles.
