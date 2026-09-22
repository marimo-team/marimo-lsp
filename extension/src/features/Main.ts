import { Layer, type LogLevel, ManagedRuntime, References } from "effect";

import * as Config from "../config/Config.ts";
import * as ConfigContextManager from "../config/ConfigContextManager.ts";
import * as CellExecutions from "../kernel/CellExecutions.ts";
import * as DebugAdapter from "../kernel/DebugAdapter.ts";
import * as NotebookControllers from "../kernel/NotebookControllers.ts";
import * as NotebookRuntime from "../kernel/NotebookRuntime.ts";
import type * as MarimoClient from "../lsp/MarimoClient.ts";
import type * as RuffLanguageServer from "../lsp/RuffLanguageServer.ts";
import type * as TyLanguageServer from "../lsp/TyLanguageServer.ts";
import * as CellMetadataUIBinding from "../notebook/CellMetadataUIBinding.ts";
import * as NotebookDocumentSessions from "../notebook/NotebookDocumentSessions.ts";
import * as NotebookEditorRegistry from "../notebook/NotebookEditorRegistry.ts";
import * as NotebookRenderer from "../notebook/NotebookRenderer.ts";
import * as NotebookSerializer from "../notebook/NotebookSerializer.ts";
import * as NotebookSessionResources from "../notebook/NotebookSessionResources.ts";
import * as DatasourcesView from "../panel/datasources/DatasourcesView.ts";
import * as NotebookDatasources from "../panel/datasources/NotebookDatasources.ts";
import * as PackagesView from "../panel/packages/PackagesView.ts";
import * as LiveSessions from "../panel/sessions/LiveSessions.ts";
import * as SessionFileLifecycle from "../panel/sessions/SessionFileLifecycle.ts";
import * as SessionsView from "../panel/sessions/SessionsView.ts";
import * as TreeView from "../panel/TreeView.ts";
import * as NotebookVariables from "../panel/variables/NotebookVariables.ts";
import * as VariablesView from "../panel/variables/VariablesView.ts";
import * as Api from "../platform/Api.ts";
import * as Constants from "../platform/Constants.ts";
import * as ExtensionContext from "../platform/ExtensionContext.ts";
import * as GitHubClient from "../platform/GitHubClient.ts";
import * as OutputChannel from "../platform/OutputChannel.ts";
import * as Storage from "../platform/Storage.ts";
import type * as VsCode from "../platform/VsCode.ts";
import * as PythonEnvInvalidation from "../python/PythonEnvInvalidation.ts";
import type * as PythonExtension from "../python/PythonExtension.ts";
import * as Uv from "../python/Uv.ts";
import { MarimoStatusBarLive } from "../statusbar/MarimoStatusBar.ts";
import { PythonEnvironmentStatusBarLive } from "../statusbar/PythonEnvironmentStatusBar.ts";
import * as StatusBar from "../statusbar/StatusBar.ts";
import * as HealthService from "../telemetry/HealthService.ts";
import type * as Telemetry from "../telemetry/Telemetry.ts";
import * as AutoExport from "./AutoExport.ts";
import * as CellInputVisibilitySync from "./CellInputVisibilitySync.ts";
import * as CellMetadataBindings from "./CellMetadataBindings.ts";
import * as CellStatusBarProvider from "./CellStatusBarProvider.ts";
import * as Debug from "./Debug.ts";
import * as MarimoCodeLensProvider from "./MarimoCodeLensProvider.ts";
import * as MarimoFileDetector from "./MarimoFileDetector.ts";
import * as RegisterCommands from "./RegisterCommands.ts";
import * as RegisterLanguageModelTools from "./RegisterLanguageModelTools.ts";
import * as ReloadOnConfigChange from "./ReloadOnConfigChange.ts";
import * as ThemeSync from "./ThemeSync.ts";

/**
 * Main application layer that wires together all services and layers
 * required for the marimo VS Code extension to function.
 */
const MainLive = Layer.empty
  .pipe(
    Layer.merge(RegisterCommands.layer),
    Layer.merge(RegisterLanguageModelTools.layer),
    Layer.merge(MarimoStatusBarLive),
    Layer.merge(PythonEnvironmentStatusBarLive),
    Layer.merge(MarimoFileDetector.layer),
    Layer.merge(MarimoCodeLensProvider.layer),
    Layer.merge(SessionsView.layer),
    Layer.merge(SessionFileLifecycle.layer),
    Layer.merge(VariablesView.layer),
    Layer.merge(DatasourcesView.layer),
    Layer.merge(PackagesView.layer),
    Layer.merge(CellStatusBarProvider.layer),
    Layer.merge(CellMetadataBindings.layer),
    Layer.merge(AutoExport.layer),
    Layer.merge(ReloadOnConfigChange.layer),
    Layer.merge(ConfigContextManager.layer),
    Layer.merge(ThemeSync.layer),
    Layer.merge(CellInputVisibilitySync.layer),
    Layer.merge(Debug.layer),
    Layer.merge(NotebookControllers.layer),
  )
  .pipe(
    Layer.provideMerge(Api.layer),
    Layer.provide(DebugAdapter.layer),
    Layer.provide(GitHubClient.defaultLayer),
    Layer.provide(NotebookRenderer.layer),
    Layer.provide(NotebookSerializer.layer),
    Layer.provide(CellExecutions.layer),
    Layer.provide(NotebookVariables.defaultLayer),
    Layer.provide(NotebookDatasources.defaultLayer),
    Layer.provideMerge(LiveSessions.layer),
    Layer.provide(HealthService.layer),
    Layer.provide(CellMetadataUIBinding.layer),
  )
  .pipe(
    Layer.provide(NotebookSessionResources.layer),
    Layer.provide(NotebookDocumentSessions.layer),
    Layer.provide(NotebookEditorRegistry.layer),
    Layer.provide(Uv.layer),
    Layer.provide(TreeView.layer),
    Layer.provide(StatusBar.layer),
    Layer.provide(Storage.layer),
    Layer.provide(Constants.defaultLayer),
    Layer.provide(Config.layer),
    Layer.provide(OutputChannel.layer),
    Layer.provide(PythonEnvInvalidation.layer),
    Layer.provide(NotebookRuntime.defaultLayer),
  );

export function makeExtension(
  layer: Layer.Layer<
    | MarimoClient.Service
    | VsCode.Service
    | PythonExtension.Service
    | Telemetry.Service
    | TyLanguageServer.Service
    | RuffLanguageServer.Service,
    never,
    ExtensionContext.Service
  >,
  minimumLogLevel: LogLevel.LogLevel,
): {
  readonly activate: (
    context: ExtensionContext.Interface,
  ) => Promise<Api.Interface>;
  readonly deactivate: () => Promise<void>;
} {
  let closeActive: (() => Promise<void>) | undefined;

  return {
    async activate(context): Promise<Api.Interface> {
      if (closeActive !== undefined) {
        throw new Error("Extension is already active");
      }

      const appLayer = Layer.provide(
        Layer.provide(MainLive, layer),
        Layer.succeed(ExtensionContext.Service, context),
      ).pipe(
        Layer.merge(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      );
      const runtime = ManagedRuntime.make(appLayer);
      closeActive = runtime.dispose;

      try {
        const api = await runtime.runPromise(Api.Service);
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
