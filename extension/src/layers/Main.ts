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
import { CellStateManager } from "../services/CellStateManager.ts";
import { CellStatusBarProvider } from "../services/CellStatusBarProvider.ts";
import { Config } from "../services/Config.ts";
import { ControllerRegistry } from "../services/ControllerRegistry.ts";
import { DebugAdapter } from "../services/DebugAdapter.ts";
import { ExecutionRegistry } from "../services/ExecutionRegistry.ts";
import { GitHubClient } from "../services/GitHubClient.ts";
import type { LanguageClient } from "../services/LanguageClient.ts";
import { NotebookEditorRegistry } from "../services/NotebookEditorRegistry.ts";
import { NotebookRenderer } from "../services/NotebookRenderer.ts";
import { NotebookSerializer } from "../services/NotebookSerializer.ts";
import { OutputChannel } from "../services/OutputChannel.ts";
import type { PythonExtension } from "../services/PythonExtension.ts";
import { ExtensionContext, Storage } from "../services/Storage.ts";
import { Uv } from "../services/Uv.ts";
import type { VsCode } from "../services/VsCode.ts";
import { MarimoStatusBarLive } from "../views/MarimoStatusBar.ts";
import { RecentNotebooksLive } from "../views/RecentNotebooks.ts";
import { StatusBar } from "../views/StatusBar.ts";
import { TreeView } from "../views/TreeView.ts";
import { KernelManagerLive } from "./KernelManager.ts";
import { LspLive } from "./Lsp.ts";
import { RegisterCommandsLive } from "./RegisterCommands.ts";

/**
 * Main application layer that wires together all services and layers
 * required for the marimo VS Code extension to function.
 */
const MainLive = LspLive.pipe(
  Layer.merge(RegisterCommandsLive),
  Layer.merge(KernelManagerLive),
  Layer.merge(MarimoStatusBarLive),
  Layer.merge(RecentNotebooksLive),
  Layer.provide(Uv.Default),
  Layer.provide(GitHubClient.Default),
  Layer.provide(DebugAdapter.Default),
  Layer.provide(NotebookRenderer.Default),
  Layer.provide(NotebookSerializer.Default),
  Layer.provide(ExecutionRegistry.Default),
  Layer.provide(CellStateManager.Default),
  Layer.provide(CellStatusBarProvider.Default),
  Layer.provide(ControllerRegistry.Default),
  Layer.provide(NotebookEditorRegistry.Default),
  Layer.provide(TreeView.Default),
  Layer.provide(StatusBar.Default),
  Layer.provide(Storage.Default),
  Layer.provide(Config.Default),
  Layer.provide(OutputChannel.Default),
);

export function makeActivate(
  layer: Layer.Layer<LanguageClient | VsCode | PythonExtension>,
  minimumLogLevel: LogLevel.LogLevel,
): (
  context: Pick<vscode.ExtensionContext, "globalState" | "workspaceState">,
) => Promise<vscode.Disposable> {
  return (context) =>
    pipe(
      Effect.gen(function* () {
        // Create a scope and build layers with it. Layer.buildWithScope completes
        // once all layer initialization finishes (commands registered, serializer
        // registered, LSP client started), but keeps resources alive by extending
        // their lifetime to the manually-managed scope. Resources are only released
        // when we explicitly close the scope on deactivation.
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
