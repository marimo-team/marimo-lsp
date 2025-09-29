import { Data, Effect, Either, FiberSet } from "effect";
import * as vscode from "vscode";
import type { AssertionError } from "../assert.ts";

export class VsCodeError extends Data.TaggedError("VsCodeError")<{
  cause: unknown;
}> {}

type Command = "workbench.action.reloadWindow";

class Commands extends Effect.Service<Commands>()("Commands", {
  scoped: Effect.gen(function* () {
    const api = vscode.commands;
    const runPromise = yield* FiberSet.makeRuntimePromise();
    return {
      executeCommand(command: Command) {
        return Effect.promise(() => api.executeCommand(command));
      },
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
}) {}

class Window extends Effect.Service<Window>()("Window", {
  effect: Effect.gen(function* () {
    const api = vscode.window;
    type WindowApi = typeof api;
    return {
      use<T>(cb: (win: WindowApi) => Thenable<T>) {
        return Effect.tryPromise({
          try: () => cb(api),
          catch: (cause) => new VsCodeError({ cause }),
        });
      },
      useInfallible<T>(cb: (win: WindowApi) => Thenable<T>) {
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

class Workspace extends Effect.Service<Workspace>()("Workspace", {
  sync: () => {
    const api = vscode.workspace;
    return {
      registerNotebookSerializer(
        notebookType: string,
        impl: vscode.NotebookSerializer,
      ) {
        return Effect.acquireRelease(
          Effect.sync(() => api.registerNotebookSerializer(notebookType, impl)),
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
}) {}

class Env extends Effect.Service<Env>()("Env", {
  sync: () => {
    const api = vscode.env;
    type EnvApi = typeof api;
    return {
      use<T>(cb: (win: EnvApi) => Thenable<T>) {
        return Effect.tryPromise({
          try: () => cb(api),
          catch: (cause) => new VsCodeError({ cause }),
        });
      },
      useInfallible<T>(cb: (win: EnvApi) => Thenable<T>) {
        return Effect.promise(() => cb(api));
      },
    };
  },
}) {}

class ParseUriError extends Data.TaggedError("ParseUriError")<{
  cause: unknown;
}> {}

/**
 * Wraps VS Code API functionality in Effect services
 */
export class VsCode extends Effect.Service<VsCode>()("VsCode", {
  effect: Effect.gen(function* () {
    return {
      window: yield* Window,
      workspace: yield* Workspace,
      commands: yield* Commands,
      env: yield* Env,
      utils: {
        parseUri(value: string) {
          return Either.try({
            try: () => vscode.Uri.parse(value, /* strict*/ true),
            catch: (cause) => new ParseUriError({ cause }),
          });
        },
      },
    };
  }),
  dependencies: [
    Window.Default,
    Workspace.Default,
    Commands.Default,
    Env.Default,
  ],
}) {}
