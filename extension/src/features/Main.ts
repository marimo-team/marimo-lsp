import { Layer, Logger, type LogLevel, ManagedRuntime } from "effect";
import type * as vscode from "vscode";

import { Config } from "../config/Config.ts";
import { ConfigContextManagerLive } from "../config/ConfigContextManager.ts";
import { MarimoConfigurationService } from "../config/MarimoConfigurationService.ts";
import { CellExecutions } from "../kernel/CellExecutions.ts";
import { DebugAdapter } from "../kernel/DebugAdapter.ts";
import { NotebookControllersLive } from "../kernel/NotebookControllers.ts";
import { NotebookRuntime } from "../kernel/NotebookRuntime.ts";
import type { MarimoClient } from "../lsp/MarimoClient.ts";
import type { RuffLanguageServer } from "../lsp/RuffLanguageServer.ts";
import type { TyLanguageServer } from "../lsp/TyLanguageServer.ts";
import { CellMetadataUIBindingService } from "../notebook/CellMetadataUIBindingService.ts";
import { NotebookEditorRegistry } from "../notebook/NotebookEditorRegistry.ts";
import { NotebookRenderer } from "../notebook/NotebookRenderer.ts";
import { NotebookSerializer } from "../notebook/NotebookSerializer.ts";
import { DatasourcesService } from "../panel/datasources/DatasourcesService.ts";
import { DatasourcesViewLive } from "../panel/datasources/DatasourcesView.ts";
import { PackagesService } from "../panel/packages/PackagesService.ts";
import { PackagesViewLive } from "../panel/packages/PackagesView.ts";
import { SessionFileLifecycleLive } from "../panel/sessions/SessionFileLifecycle.ts";
import { SessionsService } from "../panel/sessions/SessionsService.ts";
import { SessionsViewLive } from "../panel/sessions/SessionsView.ts";
import { TreeView } from "../panel/TreeView.ts";
import { VariablesService } from "../panel/variables/VariablesService.ts";
import { VariablesViewLive } from "../panel/variables/VariablesView.ts";
import { Api, type MarimoApi } from "../platform/Api.ts";
import { Constants } from "../platform/Constants.ts";
import { GitHubClient } from "../platform/GitHubClient.ts";
import { OutputChannel } from "../platform/OutputChannel.ts";
import { ExtensionContext, Storage } from "../platform/Storage.ts";
import type { VsCode } from "../platform/VsCode.ts";
import { PythonEnvInvalidation } from "../python/PythonEnvInvalidation.ts";
import type { PythonExtension } from "../python/PythonExtension.ts";
import { Uv } from "../python/Uv.ts";
import { MarimoStatusBarLive } from "../statusbar/MarimoStatusBar.ts";
import { PythonEnvironmentStatusBarLive } from "../statusbar/PythonEnvironmentStatusBar.ts";
import { StatusBar } from "../statusbar/StatusBar.ts";
import { HealthService } from "../telemetry/HealthService.ts";
import type { Telemetry } from "../telemetry/Telemetry.ts";
import { AutoExportLive } from "./AutoExport.ts";
import { CellInputVisibilitySyncLive } from "./CellInputVisibilitySync.ts";
import { CellMetadataBindingsLive } from "./CellMetadataBindings.ts";
import { CellStatusBarProviderLive } from "./CellStatusBarProvider.ts";
import { DebugLayerLive } from "./DebugLayer.ts";
import { MarimoCodeLensProviderLive } from "./MarimoCodeLensProvider.ts";
import { MarimoFileDetectorLive } from "./MarimoFileDetector.ts";
import { RegisterCommandsLive } from "./RegisterCommands.ts";
import { RegisterLanguageModelToolsLive } from "./RegisterLanguageModelTools.ts";
import { ReloadOnConfigChangeLive } from "./ReloadOnConfigChange.ts";
import { ThemeSyncLive } from "./ThemeSync.ts";

/**
 * Main application layer that wires together all services and layers
 * required for the marimo VS Code extension to function.
 */
const MainLive = Layer.empty
  .pipe(
    Layer.merge(RegisterCommandsLive),
    Layer.merge(RegisterLanguageModelToolsLive),
    Layer.merge(MarimoStatusBarLive),
    Layer.merge(PythonEnvironmentStatusBarLive),
    Layer.merge(MarimoFileDetectorLive),
    Layer.merge(MarimoCodeLensProviderLive),
    Layer.merge(SessionsViewLive),
    Layer.merge(SessionFileLifecycleLive),
    Layer.merge(VariablesViewLive),
    Layer.merge(DatasourcesViewLive),
    Layer.merge(PackagesViewLive),
    Layer.merge(CellStatusBarProviderLive),
    Layer.merge(CellMetadataBindingsLive),
    Layer.merge(AutoExportLive),
    Layer.merge(ReloadOnConfigChangeLive),
    Layer.merge(ConfigContextManagerLive),
    Layer.merge(ThemeSyncLive),
    Layer.merge(CellInputVisibilitySyncLive),
    Layer.merge(DebugLayerLive),
    Layer.merge(NotebookControllersLive),
  )
  .pipe(
    Layer.provideMerge(Api.Default),
    Layer.provide(DebugAdapter.Default),
    Layer.provide(GitHubClient.Default),
    Layer.provide(NotebookRenderer.Default),
    Layer.provide(NotebookSerializer.Default),
    Layer.provide(CellExecutions.Default),
    Layer.provide(VariablesService.Default),
    Layer.provide(DatasourcesService.Default),
    Layer.provide(PackagesService.Default),
    Layer.provideMerge(SessionsService.Default),
    Layer.provide(HealthService.Default),
    Layer.provide(CellMetadataUIBindingService.Default),
  )
  .pipe(
    Layer.provide(MarimoConfigurationService.Default),
    Layer.provide(NotebookEditorRegistry.Default),
    Layer.provide(Uv.Default),
    Layer.provide(TreeView.Default),
    Layer.provide(StatusBar.Default),
    Layer.provide(Storage.Default),
    Layer.provide(Constants.Default),
    Layer.provide(Config.Default),
    Layer.provide(OutputChannel.Default),
    Layer.provide(PythonEnvInvalidation.Default),
    Layer.provide(NotebookRuntime.Default),
  );

export function makeExtension(
  layer: Layer.Layer<
    | MarimoClient
    | VsCode
    | PythonExtension
    | Telemetry
    | TyLanguageServer
    | RuffLanguageServer,
    never,
    ExtensionContext
  >,
  minimumLogLevel: LogLevel.LogLevel,
): {
  readonly activate: (
    context: Pick<
      vscode.ExtensionContext,
      "workspaceState" | "globalState" | "extensionUri" | "globalStorageUri"
    >,
  ) => Promise<MarimoApi>;
  readonly deactivate: () => Promise<void>;
} {
  let closeActive: (() => Promise<void>) | undefined;

  return {
    async activate(context): Promise<MarimoApi> {
      if (closeActive !== undefined) {
        throw new Error("Extension is already active");
      }

      const appLayer = Layer.provide(
        Layer.provide(MainLive, layer),
        Layer.succeed(ExtensionContext, context),
      ).pipe(Layer.merge(Logger.minimumLogLevel(minimumLogLevel)));
      const runtime = ManagedRuntime.make(appLayer);
      closeActive = runtime.dispose;

      try {
        const api = await runtime.runPromise(Api);
        return { experimental: api.experimental };
      } catch (error) {
        closeActive = undefined;
        await runtime.dispose();
        throw error;
      }
    },
    async deactivate(): Promise<void> {
      const close = closeActive;
      closeActive = undefined;
      await close?.();
    },
  };
}
