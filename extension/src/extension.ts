import { Effect, Fiber } from "effect";
import * as vscode from "vscode";
import { kernelManager } from "./kernelManager.ts";
import { Logger } from "./logging.ts";
import { notebookSerializer } from "./notebookSerializer.ts";
import { BaseLanguageClient, MainLive } from "./services.ts";

export async function activate(context: vscode.ExtensionContext) {
  Logger.info("Extension.Lifecycle", "Activating marimo", {
    extensionPath: context.extensionPath,
    workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  });

  const fiber = Effect.gen(function* () {
    const client = yield* BaseLanguageClient;
    yield* Effect.tryPromise(() => client.start());
    yield* Effect.logInfo("LSP client started successfully");
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => client.dispose()).pipe(
        Effect.catchTags({ UnknownException: Effect.logError }),
      ),
    );
  }).pipe(
    Effect.catchTag("UnknownException", (error) =>
      Effect.gen(function* () {
        yield* Effect.logError("Failed to start LSP client", error);
        yield* Effect.promise(() =>
          vscode.window.showErrorMessage(
            `Marimo language server failed to start. See marimo logs for more info.`,
          ),
        );
      }),
    ),
    Effect.scoped,
    Effect.provide(MainLive),
    Effect.runFork,
  );

  kernelManager(MainLive, { signal });
  notebookSerializer(MainLive, { signal });

  context.subscriptions.push({
    dispose: () => Effect.runFork(Fiber.interrupt(fiber)),
  });
}

export async function deactivate() {
  Logger.info("Extension.Lifecycle", "Deactivating marimo");
  Logger.close();
}
