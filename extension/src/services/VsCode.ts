import { Data, Effect, Either, FiberSet, Option } from "effect";

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

export class Window extends Effect.Service<Window>()("Window", {
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
      getActiveNotebookEditor() {
        return Option.fromNullable(api.activeNotebookEditor);
      },
    };
  }),
}) {}

type Command = "workbench.action.reloadWindow";

class Commands extends Effect.Service<Commands>()("Commands", {
  dependencies: [Window.Default],
  scoped: Effect.gen(function* () {
    const win = yield* Window;
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
                      yield* win.useInfallible((api) =>
                        api.showWarningMessage(
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

class Workspace extends Effect.Service<Workspace>()("Workspace", {
  sync: () => {
    const api = vscode.workspace;
    type WorkspaceApi = typeof api;
    return {
      getNotebookDocuments() {
        return api.notebookDocuments;
      },
      getConfiguration(section: string) {
        return api.getConfiguration(section);
      },
      registerNotebookSerializer(
        notebookType: string,
        impl: vscode.NotebookSerializer,
      ) {
        return Effect.acquireRelease(
          Effect.sync(() => api.registerNotebookSerializer(notebookType, impl)),
          (disposable) => Effect.sync(() => disposable.dispose()),
        );
      },
      use<T>(cb: (workspace: WorkspaceApi) => Thenable<T>) {
        return Effect.tryPromise({
          try: () => cb(api),
          catch: (cause) => new VsCodeError({ cause }),
        });
      },
      useInfallible<T>(cb: (win: WorkspaceApi) => Thenable<T>) {
        return Effect.promise(() => cb(api));
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

class AuthError extends Data.TaggedError("AuthError")<{
  cause: unknown;
}> {}

class Auth extends Effect.Service<Auth>()("Auth", {
  effect: Effect.gen(function* () {
    return {
      getSession(
        providerId: "github" | "microsoft", // could be custom but these are default
        scopes: ReadonlyArray<string>,
        options: vscode.AuthenticationGetSessionOptions,
      ) {
        return Effect.tryPromise({
          try: () =>
            vscode.authentication.getSession(providerId, scopes, options),
          catch: (cause) => new AuthError({ cause }),
        }).pipe(Effect.map(Option.fromNullable));
      },
    };
  }),
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
      commands: yield* Commands,
      workspace: yield* Workspace,
      env: yield* Env,
      debug: yield* Debug,
      notebooks: yield* Notebooks,
      auth: yield* Auth,
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
    Auth.Default,
  ],
}) {}
