import { Effect, Exit, Layer, Logger, LogLevel, pipe, Scope } from "effect";
import type * as vscode from "vscode";

import { MainLiveVsCode } from "./layers/MainVsCode.ts";
import { ExtensionContext } from "./services/Storage.ts";

export async function activate(
  context: Pick<vscode.ExtensionContext, "globalState" | "workspaceState">,
): Promise<vscode.Disposable> {
  return pipe(
    Effect.gen(function* () {
      // Create a scope and build layers with it. Layer.buildWithScope completes
      // once all layer initialization finishes (commands registered, serializer
      // registered, LSP client started), but keeps resources alive by extending
      // their lifetime to the manually-managed scope. Resources are only released
      // when we explicitly close the scope on deactivation.
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(MainLiveVsCode, scope);
      return {
        dispose: () => Effect.runPromise(Scope.close(scope, Exit.void)),
      };
    }),
    Effect.provideService(ExtensionContext, context),
    Logger.withMinimumLogLevel(LogLevel.All),
    Effect.runPromise,
  );
}

export async function deactivate() {
  // No-op: VSCode will call `dispose()` on the returned `Disposable`
  // from `activate()`, which closes the scope and releases all resources.
}
