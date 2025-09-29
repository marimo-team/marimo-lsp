import { Data, Effect, FiberSet } from "effect";
import * as vscode from "vscode";
import type { AssertionError } from "../assert.ts";

export class VsCodeError extends Data.TaggedError("VsCodeError")<{
  cause: unknown;
}> {}

class VsCodeCommands extends Effect.Service<VsCodeCommands>()(
  "VsCodeCommands",
  {
    scoped: Effect.gen(function* () {
      const api = vscode.commands;
      const runPromise = yield* FiberSet.makeRuntimePromise();
      return {
        registerCommand(
          command: string,
          effect: Effect.Effect<void, AssertionError | VsCodeError, never>,
        ) {
          return Effect.acquireRelease(
            Effect.sync(() =>
              api.registerCommand(command, () =>
                runPromise<never, void>(
                  effect.pipe(
                    Effect.catchAllCause((cause) =>
                      Effect.gen(function* () {
                        yield* Effect.logError(cause);
                        yield* Effect.promise(() =>
                          vscode.window.showWarningMessage(
                            `Something went wrong in ${JSON.stringify(command)}. See marimo logs for more info.`,
                          ),
                        );
                      }),
                    ),
                  ),
                ),
              ),
            ),
            (disposable) => Effect.sync(() => disposable.dispose()),
          );
        },
      };
    }),
  },
) {}

class VsCodeWindow extends Effect.Service<VsCodeWindow>()("VsCodeWindow", {
  effect: Effect.gen(function* () {
    const api = vscode.window;
    type VsCodeWindowApi = typeof api;
    return {
      use<T>(cb: (win: VsCodeWindowApi) => Thenable<T>) {
        return Effect.tryPromise({
          try: () => cb(api),
          catch: (cause) => new VsCodeError({ cause }),
        });
      },
      useInfallable<T>(cb: (win: VsCodeWindowApi) => Thenable<T>) {
        return Effect.promise(() => cb(api));
      },
      createOutputChannel(name: string) {
        return Effect.acquireRelease(
          Effect.sync(() => api.createOutputChannel(name, { log: true })),
          (disposable) => Effect.sync(() => disposable.dispose()),
        );
      },
    };
  }),
}) {}

class VsCodeWorkspace extends Effect.Service<VsCodeWorkspace>()(
  "VsCodeWorkspace",
  {
    sync: () => {
      const api = vscode.workspace;
      return {
        registerNotebookSerializer(
          notebookType: string,
          impl: vscode.NotebookSerializer,
        ) {
          return Effect.acquireRelease(
            Effect.sync(() =>
              api.registerNotebookSerializer(notebookType, impl),
            ),
            (disposable) => Effect.sync(() => disposable.dispose()),
          );
        },
        createEmptyPythonNotebook(notebookType: string) {
          return Effect.tryPromise({
            try: () =>
              api.openNotebookDocument(
                notebookType,
                new vscode.NotebookData([
                  new vscode.NotebookCellData(
                    vscode.NotebookCellKind.Code,
                    "",
                    "python",
                  ),
                ]),
              ),
            catch: (cause) => new VsCodeError({ cause }),
          });
        },
      };
    },
  },
) {}

export class VsCode extends Effect.Service<VsCode>()("VsCode", {
  effect: Effect.gen(function* () {
    return {
      window: yield* VsCodeWindow,
      workspace: yield* VsCodeWorkspace,
      commands: yield* VsCodeCommands,
    };
  }),
  dependencies: [
    VsCodeWindow.Default,
    VsCodeWorkspace.Default,
    VsCodeCommands.Default,
  ],
}) {}
