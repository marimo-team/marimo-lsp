import { Layer } from "effect";
import { Config } from "../services/Config.ts";
import { DebugAdapter } from "../services/DebugAdapter.ts";
import { GitHubClient } from "../services/GitHubClient.ts";
import { LanguageClient } from "../services/LanguageClient.ts";
import { NotebookControllers } from "../services/NotebookControllers.ts";
import { NotebookRenderer } from "../services/NotebookRenderer.ts";
import { NotebookSerializer } from "../services/NotebookSerializer.ts";
import { OutputChannel } from "../services/OutputChannel.ts";
import { PyPiClient } from "../services/PyPIClient.ts";
import { PythonExtension } from "../services/PythonExtension.ts";
import { VsCode } from "../services/VsCode.ts";
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
  Layer.provide(PyPiClient.Default),
  Layer.provide(GitHubClient.Default),
  Layer.provide(DebugAdapter.Default),
  Layer.provide(NotebookRenderer.Default),
  Layer.provide(NotebookControllers.Default),
  Layer.provide(NotebookSerializer.Default),
  Layer.provide(PythonExtension.Default),
  Layer.provide(LanguageClient.Default),
  Layer.provide(Config.Default),
  Layer.provide(VsCode.Default),
  // Make sure we have logging setup before everything else
  Layer.provide(LoggerLive),
  Layer.provide(OutputChannel.Default),
);
