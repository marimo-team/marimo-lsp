import { Effect, Fiber, Layer, Logger, LogLevel } from "effect";
import * as vscode from "vscode";
import { DebugAdapterLive } from "./debugAdapter.ts";
import { KernelManagerLive } from "./kernelManager.ts";
import { channel, Logger as VsCodeLogger } from "./logging.ts";
import { NotebookControllerManager } from "./notebookControllerManager.ts";
import {
  BaseLanguageClient,
  CommandsLive,
  LoggerLive,
  LspLogForwardingLive,
  MarimoConfig,
  MarimoLanguageClient,
  MarimoNotebookRenderer,
  MarimoNotebookSerializerLive,
  OutputChannel,
  PythonExtension,
} from "./services.ts";

const MainLive = LoggerLive.pipe(
  Layer.merge(CommandsLive),
  Layer.merge(DebugAdapterLive),
  Layer.merge(LspLogForwardingLive),
  Layer.merge(MarimoNotebookSerializerLive),
  Layer.merge(KernelManagerLive),
  Layer.provide(MarimoNotebookRenderer.Default),
  Layer.provide(NotebookControllerManager.Default),
  Layer.provide(PythonExtension.Default),
  Layer.provide(MarimoLanguageClient.Default),
  Layer.provideMerge(BaseLanguageClient.Default),
  Layer.provide(MarimoConfig.Default),
  Layer.provide(OutputChannel.layer(channel)),
);

export async function activate(context: vscode.ExtensionContext) {
  VsCodeLogger.info("Extension.Lifecycle", "Activating marimo", {
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
    Logger.withMinimumLogLevel(LogLevel.All),
    Effect.scoped,
    Effect.provide(MainLive),
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
