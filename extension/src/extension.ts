import { Effect, Exit, Layer, Logger, LogLevel, pipe, Scope } from "effect";
import * as vscode from "vscode";

import { MainLive } from "./layers/Main.ts";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<vscode.Disposable> {
  return pipe(
    Effect.gen(function* () {
      yield* Effect.logInfo("Activating marimo extension").pipe(
        Effect.annotateLogs({
          extensionPath: context.extensionPath,
          workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        }),
      );
      // Create a scope and build layers with it. Layer.buildWithScope completes
      // once all layer initialization finishes (commands registered, serializer
      // registered, LSP client started), but keeps resources alive by extending
      // their lifetime to the manually-managed scope. Resources are only released
      // when we explicitly close the scope on deactivation.
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(MainLive, scope);
      return {
        dispose: () =>
          Effect.runPromise(
            Effect.gen(function* () {
              yield* Effect.logInfo("Deactivating marimo extension");
              yield* Scope.close(scope, Exit.void);
            }),
          ),
      };
    }),
    Logger.withMinimumLogLevel(LogLevel.All),
    Effect.runPromise,
  );
}

export async function deactivate() {
  // No-op: VSCode will call `dispose()` on the returned `Disposable`
  // from `activate()`, which closes the scope and releases all resources.
}
