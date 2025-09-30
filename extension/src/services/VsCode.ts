import { Data, Effect, Either, FiberSet } from "effect";
// VsCode.ts is the centralized service that wraps the VS Code API.
//
// All other modules should use type-only imports and access the API through this service.
//
// biome-ignore lint: See above
import * as vscode from "vscode";
import type { AssertionError } from "../assert.ts";

export class VsCodeError extends Data.TaggedError("VsCodeError")<{
  cause: unknown;
}> {}

type Command = "workbench.action.reloadWindow";

class Commands extends Effect.Service<Commands>()("Commands", {
  scoped: Effect.gen(function* () {
    const runPromise = yield* FiberSet.makeRuntimePromise();
    return {
      executeCommand(command: Command) {
        return Effect.promise(() => vscode.commands.executeCommand(command));
      },
      registerCommand(
        command: string,
        effect: Effect.Effect<void, AssertionError | VsCodeError, never>,
      ) {
        return Effect.acquireRelease(
          Effect.sync(() =>
            vscode.commands.registerCommand(command, () =>
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
    type WindowApi = typeof vscode.window;
    return {
      use<T>(cb: (win: WindowApi) => Thenable<T>) {
        return Effect.tryPromise({
          try: () => cb(vscode.window),
          catch: (cause) => new VsCodeError({ cause }),
        });
      },
      useInfallible<T>(cb: (win: WindowApi) => Thenable<T>) {
        return Effect.promise(() => cb(vscode.window));
      },
      createOutputChannel(name: string) {
        return Effect.acquireRelease(
          Effect.sync(() =>
            vscode.window.createOutputChannel(name, { log: true }),
          ),
          (disposable) => Effect.sync(() => disposable.dispose()),
        );
      },
      get activeNotebookEditor() {
        return vscode.window.activeNotebookEditor;
      },
    };
  }),
}) {}

class Workspace extends Effect.Service<Workspace>()("Workspace", {
  sync: () => {
    type WorkspaceApi = typeof vscode.workspace;
    return {
      getConfiguration(section: string) {
        return vscode.workspace.getConfiguration(section);
      },
      registerNotebookSerializer(
        notebookType: string,
        impl: vscode.NotebookSerializer,
      ) {
        return Effect.acquireRelease(
          Effect.sync(() =>
            vscode.workspace.registerNotebookSerializer(notebookType, impl),
          ),
          (disposable) => Effect.sync(() => disposable.dispose()),
        );
      },
      use<T>(cb: (workspace: WorkspaceApi) => Thenable<T>) {
        return Effect.tryPromise({
          try: () => cb(vscode.workspace),
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

class Debug extends Effect.Service<Debug>()("Debug", {
  scoped: Effect.gen(function* () {
    const api = vscode.debug;
    return {
      registerDebugConfigurationProvider(
        debugType: string,
        factory: vscode.DebugConfigurationProvider,
      ) {
        return Effect.acquireRelease(
          Effect.sync(() =>
            api.registerDebugConfigurationProvider(debugType, factory),
          ),
          (disposable) => Effect.sync(() => disposable.dispose()),
        );
      },
      registerDebugAdapterDescriptorFactory(
        debugType: string,
        factory: vscode.DebugAdapterDescriptorFactory,
      ) {
        return Effect.acquireRelease(
          Effect.sync(() =>
            api.registerDebugAdapterDescriptorFactory(debugType, factory),
          ),
          (disposable) => Effect.sync(() => disposable.dispose()),
        );
      },
    };
  }),
}) {}

class Notebooks extends Effect.Service<Notebooks>()("Notebooks", {
  sync: () => {
    const api = vscode.notebooks;
    return {
      createRendererMessaging: api.createRendererMessaging,
      createNotebookController(
        id: string,
        notebookType: string,
        label: string,
      ) {
        return Effect.acquireRelease(
          Effect.sync(() =>
            api.createNotebookController(id, notebookType, label),
          ),
          (disposable) => Effect.sync(() => disposable.dispose()),
        );
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
      // namespaces
      window: yield* Window,
      workspace: yield* Workspace,
      commands: yield* Commands,
      env: yield* Env,
      debug: yield* Debug,
      notebooks: yield* Notebooks,
      // data types
      NotebookData: vscode.NotebookData,
      NotebookCellData: vscode.NotebookCellData,
      NotebookCellKind: vscode.NotebookCellKind,
      NotebookCellOutput: vscode.NotebookCellOutput,
      NotebookCellOutputItem: vscode.NotebookCellOutputItem,
      EventEmitter: vscode.EventEmitter,
      DebugAdapterInlineImplementation: vscode.DebugAdapterInlineImplementation,
      // helper
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
    Debug.Default,
    Notebooks.Default,
  ],
}) {}
