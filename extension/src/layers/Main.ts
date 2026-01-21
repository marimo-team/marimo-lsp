import {
  Effect,
  Exit,
  Layer,
  Logger,
  type LogLevel,
  pipe,
  Scope,
} from "effect";
import type * as vscode from "vscode";
import { CellMetadataUIBindingService } from "../services/CellMetadataUIBindingService.ts";
import { CellStateManager } from "../services/CellStateManager.ts";
import { Config } from "../services/Config.ts";
import { Constants } from "../services/Constants.ts";
import { ControllerRegistry } from "../services/ControllerRegistry.ts";
import { RuffLanguageServer } from "../services/completions/RuffLanguageServer.ts";
import { TyLanguageServer } from "../services/completions/TyLanguageServer.ts";
import { ConfigContextManager } from "../services/config/ConfigContextManager.ts";
import { MarimoConfigurationService } from "../services/config/MarimoConfigurationService.ts";
import { DebugAdapter } from "../services/DebugAdapter.ts";
import { DatasourcesService } from "../services/datasources/DatasourcesService.ts";
import { ExecutionRegistry } from "../services/ExecutionRegistry.ts";
import { GitHubClient } from "../services/GitHubClient.ts";
import { HealthService } from "../services/HealthService.ts";
import type { LanguageClient } from "../services/LanguageClient.ts";
import { NotebookEditorRegistry } from "../services/NotebookEditorRegistry.ts";
import { NotebookRenderer } from "../services/NotebookRenderer.ts";
import { NotebookSerializer } from "../services/NotebookSerializer.ts";
import { OutputChannel } from "../services/OutputChannel.ts";
import type { PythonExtension } from "../services/PythonExtension.ts";
import { PackagesService } from "../services/packages/PackagesService.ts";
import { SandboxController } from "../services/SandboxController.ts";
import { Sentry } from "../services/Sentry.ts";
import { SessionStateManager } from "../services/SessionStateManager.ts";
import { ExtensionContext, Storage } from "../services/Storage.ts";
import { Telemetry } from "../services/Telemetry.ts";
import { Uv } from "../services/Uv.ts";
import type { VsCode } from "../services/VsCode.ts";
import { VariablesService } from "../services/variables/VariablesService.ts";
import { DatasourcesViewLive } from "../views/DatasourcesView.ts";
import { MarimoStatusBarLive } from "../views/MarimoStatusBar.ts";
import { PackagesViewLive } from "../views/PackagesView.ts";
import { PythonEnvironmentStatusBarLive } from "../views/PythonEnvironmentStatusBar.ts";
import { RecentNotebooksLive } from "../views/RecentNotebooks.ts";
import { StatusBar } from "../views/StatusBar.ts";
import { TreeView } from "../views/TreeView.ts";
import { VariablesViewLive } from "../views/VariablesView.ts";
import { CellMetadataBindingsLive } from "./CellMetadataBindings.ts";
import { CellStatusBarProviderLive } from "./CellStatusBarProvider.ts";
import { KernelManagerLive } from "./KernelManager.ts";
import { MarimoCodeLensProviderLive } from "./MarimoCodeLensProvider.ts";
import { MarimoFileDetectorLive } from "./MarimoFileDetector.ts";
import { NotebookLanguageFeaturesLive } from "./NotebookLanguageFeatures.ts";
import { RegisterCommandsLive } from "./RegisterCommands.ts";

/**
 * Main application layer that wires together all services and layers
 * required for the marimo VS Code extension to function.
 */
const MainLive = Layer.empty
  .pipe(
    Layer.merge(RegisterCommandsLive),
    Layer.merge(KernelManagerLive),
    Layer.merge(MarimoStatusBarLive),
    Layer.merge(PythonEnvironmentStatusBarLive),
    Layer.merge(MarimoFileDetectorLive),
    Layer.merge(MarimoCodeLensProviderLive),
    Layer.merge(NotebookLanguageFeaturesLive),
    Layer.merge(RecentNotebooksLive),
    Layer.merge(VariablesViewLive),
    Layer.merge(DatasourcesViewLive),
    Layer.merge(PackagesViewLive),
    Layer.merge(CellStatusBarProviderLive),
    Layer.merge(CellMetadataBindingsLive),
  )
  .pipe(
    Layer.provide(RuffLanguageServer.Default),
    Layer.provide(TyLanguageServer.Default),
    Layer.provide(GitHubClient.Default),
    Layer.provide(DebugAdapter.Default),
    Layer.provide(NotebookRenderer.Default),
    Layer.provide(NotebookSerializer.Default),
    Layer.provide(ExecutionRegistry.Default),
    Layer.provide(VariablesService.Default),
    Layer.provide(DatasourcesService.Default),
    Layer.provide(PackagesService.Default),
    Layer.provide(HealthService.Default),
    Layer.provide(CellMetadataUIBindingService.Default),
  )
  .pipe(
    Layer.provide(MarimoConfigurationService.Default),
    Layer.provide(ConfigContextManager.Default),
    Layer.provide(CellStateManager.Default),
    Layer.provide(SessionStateManager.Default),
    Layer.provide(ControllerRegistry.Default),
    Layer.provide(NotebookEditorRegistry.Default),
    Layer.provide(SandboxController.Default),
    Layer.provide(Uv.Default),
    Layer.provide(TreeView.Default),
    Layer.provide(StatusBar.Default),
    Layer.provide(Storage.Default),
    Layer.provide(Constants.Default),
    Layer.provide(Config.Default),
    Layer.provide(OutputChannel.Default),
    Layer.provide(Telemetry.Default),
    Layer.provide(Sentry.Default),
  );

export function makeActivate(
  layer: Layer.Layer<LanguageClient | VsCode | PythonExtension>,
  minimumLogLevel: LogLevel.LogLevel,
): (
  context: Pick<
    vscode.ExtensionContext,
    "globalState" | "workspaceState" | "extensionUri"
  >,
) => Promise<vscode.Disposable> {
  return (context) =>
    pipe(
      Effect.gen(function* () {
        // Create a scope and build layers with it. Layer.buildWithScope completes
        // once all layer initialization finishes (commands registered, serializer
        // registered, notification streams set up). The LSP client will start lazily
        // on first use. Resources are kept alive by extending their lifetime to the
        // manually-managed scope, and are only released when we explicitly close the
        // scope on deactivation.
        const scope = yield* Scope.make();
        yield* Layer.buildWithScope(Layer.provide(MainLive, layer), scope);

        return {
          dispose: () => Effect.runPromise(Scope.close(scope, Exit.void)),
        };
      }),
      Effect.provideService(ExtensionContext, context),
      Logger.withMinimumLogLevel(minimumLogLevel),
      Effect.runPromise,
    );
}
