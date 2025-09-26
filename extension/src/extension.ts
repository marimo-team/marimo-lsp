import { Effect, Fiber, Layer, Logger, LogLevel } from "effect";
import * as vscode from "vscode";
import { MainLive } from "./layers.ts";
import { Logger as VsCodeLogger } from "./logging.ts";

export async function activate(context: vscode.ExtensionContext) {
  VsCodeLogger.info("Extension.Lifecycle", "Activating marimo", {
    extensionPath: context.extensionPath,
    workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  });
  const fiber = Layer.launch(MainLive).pipe(
    Logger.withMinimumLogLevel(LogLevel.All),
    Effect.runFork,
  );
  context.subscriptions.push({
    dispose: () => Effect.runFork(Fiber.interrupt(fiber)),
  });
}

export async function deactivate() {
  VsCodeLogger.info("Extension.Lifecycle", "Deactivating marimo");
  VsCodeLogger.close();
}
