import { Layer } from "effect";
import { CellStateManager } from "../services/CellStateManager.ts";
import { CellStatusBarProvider } from "../services/CellStatusBarProvider.ts";
import { Config } from "../services/Config.ts";
import { ControllerRegistry } from "../services/ControllerRegistry.ts";
import { DebugAdapter } from "../services/DebugAdapter.ts";
import { ExecutionRegistry } from "../services/ExecutionRegistry.ts";
import { GitHubClient } from "../services/GitHubClient.ts";
import { LanguageClient } from "../services/LanguageClient.ts";
import { NotebookEditorRegistry } from "../services/NotebookEditorRegistry.ts";
import { NotebookRenderer } from "../services/NotebookRenderer.ts";
import { NotebookSerializer } from "../services/NotebookSerializer.ts";
import { OutputChannel } from "../services/OutputChannel.ts";
import { PythonExtension } from "../services/PythonExtension.ts";
import { Storage } from "../services/Storage.ts";
import { Uv } from "../services/Uv.ts";
import { VsCode } from "../services/VsCode.ts";
import { MarimoStatusBarLive } from "../views/MarimoStatusBar.ts";
import { RecentNotebooksLive } from "../views/RecentNotebooks.ts";
import { StatusBar } from "../views/StatusBar.ts";
import { TreeView } from "../views/TreeView.ts";
import { KernelManagerLive } from "./KernelManager.ts";
import { LoggerLive } from "./Logger.ts";
import { LspLive } from "./Lsp.ts";
import { RegisterCommandsLive } from "./RegisterCommands.ts";

/**
 * Main application layer that wires together all services and layers
 * required for the marimo VS Code extension to function.
 */
export const MainLive = LspLive.pipe(
  Layer.merge(RegisterCommandsLive),
  Layer.merge(KernelManagerLive),
  Layer.merge(MarimoStatusBarLive),
  Layer.merge(RecentNotebooksLive),
).pipe(
  Layer.provide(Uv.Default),
  Layer.provide(GitHubClient.Default),
  Layer.provide(DebugAdapter.Default),
  Layer.provide(NotebookRenderer.Default),
  Layer.provide(NotebookSerializer.Default),
  Layer.provide(LanguageClient.Default),
  Layer.provide(PythonExtension.Default),
  Layer.provide(ExecutionRegistry.Default),
  Layer.provide(CellStateManager.Default),
  Layer.provide(CellStatusBarProvider.Default),
  Layer.provide(ControllerRegistry.Default),
  Layer.provide(NotebookEditorRegistry.Default),
  Layer.provide(TreeView.Default),
  Layer.provide(StatusBar.Default),
  Layer.provide(Storage.Default),
  Layer.provide(Config.Default),
  Layer.provide(VsCode.Default),
  // Make sure we have logging setup before everything else
  Layer.provide(LoggerLive),
  Layer.provide(OutputChannel.Default),
);
