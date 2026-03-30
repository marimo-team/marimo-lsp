import {
  Context,
  Effect,
  Exit,
  Layer,
  Logger,
  type LogLevel,
  pipe,
  Scope,
} from "effect";
import type * as vscode from "vscode";

import { Api, type MarimoApi } from "../platform/Api.ts";
import { CellMetadataUIBindingService } from "../notebook/CellMetadataUIBindingService.ts";
import { CellStateManager } from "../notebook/CellStateManager.ts";
import { Config } from "../config/Config.ts";
import { ConfigContextManager } from "../config/ConfigContextManager.ts";
import { MarimoConfigurationService } from "../config/MarimoConfigurationService.ts";
import { Constants } from "../platform/Constants.ts";
import { ControllerRegistry } from "../kernel/ControllerRegistry.ts";
import { DatasourcesService } from "../panel/datasources/DatasourcesService.ts";
import { DebugAdapter } from "../kernel/DebugAdapter.ts";
import { ExecutionRegistry } from "../kernel/ExecutionRegistry.ts";
import { GitHubClient } from "../platform/GitHubClient.ts";
import { HealthService } from "../telemetry/HealthService.ts";
import { KernelManager } from "../kernel/KernelManager.ts";
import type { LanguageClient } from "../lsp/LanguageClient.ts";
import { NotebookEditorRegistry } from "../notebook/NotebookEditorRegistry.ts";
import { NotebookRenderer } from "../notebook/NotebookRenderer.ts";
import { NotebookSerializer } from "../notebook/NotebookSerializer.ts";
import { OutputChannel } from "../platform/OutputChannel.ts";
import { PackagesService } from "../panel/packages/PackagesService.ts";
import { PythonEnvInvalidation } from "../python/PythonEnvInvalidation.ts";
import type { PythonExtension } from "../python/PythonExtension.ts";
import type { RuffLanguageServer } from "../lsp/RuffLanguageServer.ts";
import { SandboxController } from "../kernel/SandboxController.ts";
import type { Sentry } from "../telemetry/Sentry.ts";
import { SessionStateManager } from "../kernel/SessionStateManager.ts";
import { ExtensionContext, Storage } from "../platform/Storage.ts";
import type { Telemetry } from "../telemetry/Telemetry.ts";
import type { TyLanguageServer } from "../lsp/TyLanguageServer.ts";
import { Uv } from "../python/Uv.ts";
import { VariablesService } from "../panel/variables/VariablesService.ts";
import type { VsCode } from "../platform/VsCode.ts";
import { DatasourcesViewLive } from "../panel/datasources/DatasourcesView.ts";
import { MarimoStatusBarLive } from "../statusbar/MarimoStatusBar.ts";
import { PackagesViewLive } from "../panel/packages/PackagesView.ts";
import { PythonEnvironmentStatusBarLive } from "../statusbar/PythonEnvironmentStatusBar.ts";
import { RecentNotebooksLive } from "../panel/RecentNotebooks.ts";
import { StatusBar } from "../statusbar/StatusBar.ts";
import { TreeView } from "../panel/TreeView.ts";
import { VariablesViewLive } from "../panel/variables/VariablesView.ts";
import { CellMetadataBindingsLive } from "./CellMetadataBindings.ts";
import { CellStatusBarProviderLive } from "./CellStatusBarProvider.ts";
import { DebugLayerLive } from "./DebugLayer.ts";
import { MarimoCodeLensProviderLive } from "./MarimoCodeLensProvider.ts";
import { MarimoFileDetectorLive } from "./MarimoFileDetector.ts";
import { RegisterCommandsLive } from "./RegisterCommands.ts";
import { ReloadOnConfigChangeLive } from "./ReloadOnConfigChange.ts";
import { ThemeSyncLive } from "./ThemeSync.ts";

/**
 * Main application layer that wires together all services and layers
 * required for the marimo VS Code extension to function.
 */
const MainLive = Layer.empty
  .pipe(
    Layer.merge(RegisterCommandsLive),
    Layer.merge(MarimoStatusBarLive),
    Layer.merge(PythonEnvironmentStatusBarLive),
    Layer.merge(MarimoFileDetectorLive),
    Layer.merge(MarimoCodeLensProviderLive),
    Layer.merge(RecentNotebooksLive),
    Layer.merge(VariablesViewLive),
    Layer.merge(DatasourcesViewLive),
    Layer.merge(PackagesViewLive),
    Layer.merge(CellStatusBarProviderLive),
    Layer.merge(CellMetadataBindingsLive),
    Layer.merge(ReloadOnConfigChangeLive),
    Layer.merge(ThemeSyncLive),
    Layer.merge(DebugLayerLive),
  )
  .pipe(
    Layer.provideMerge(Api.Default),
    Layer.provide(DebugAdapter.Default),
    Layer.provide(KernelManager.Default),
    Layer.provide(GitHubClient.Default),
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
    Layer.provide(PythonEnvInvalidation.Default),
  );

export function makeActivate(
  layer: Layer.Layer<
    | LanguageClient
    | VsCode
    | PythonExtension
    | Telemetry
    | Sentry
    | TyLanguageServer
    | RuffLanguageServer,
    never,
    ExtensionContext
  >,
  minimumLogLevel: LogLevel.LogLevel,
): (
  context: Pick<
    vscode.ExtensionContext,
    "workspaceState" | "globalState" | "extensionUri" | "globalStorageUri"
  >,
) => Promise<vscode.Disposable & MarimoApi> {
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
        const ctx = yield* Layer.buildWithScope(
          Layer.provide(MainLive, layer),
          scope,
        );
        const api = Context.get(ctx, Api);
        return {
          ...api,
          dispose: () => Effect.runPromise(Scope.close(scope, Exit.void)),
        };
      }),
      Effect.provideService(ExtensionContext, context),
      Logger.withMinimumLogLevel(minimumLogLevel),
      Effect.runPromise,
    );
}
