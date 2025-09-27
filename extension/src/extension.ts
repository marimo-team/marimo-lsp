import { Effect, Exit, Layer, Logger, LogLevel, pipe, Scope } from "effect";
import * as vscode from "vscode";
import { MainLive } from "./layers.ts";
import { Logger as VsCodeLogger } from "./logging.ts";

export async function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    await pipe(
      Effect.gen(function* () {
        yield* Effect.logInfo("Activating marimo extension").pipe(
          Effect.annotateLogs({
            extensionPath: context.extensionPath,
            workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          }),
        );
        const scope = yield* Scope.make();
        yield* Layer.buildWithScope(MainLive, scope);
        // All layers initialized here (commands registered, serializer registered, client started)
        return {
          dispose: () => Effect.runPromise(Scope.close(scope, Exit.void)),
        };
      }),
      Logger.withMinimumLogLevel(LogLevel.All),
      Effect.runPromise,
    ),
  );
}

export async function deactivate() {
  VsCodeLogger.info("Extension.Lifecycle", "Deactivating marimo");
  VsCodeLogger.close();
}
