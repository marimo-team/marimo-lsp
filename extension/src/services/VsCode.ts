import {
  Data,
  Effect,
  Either,
  Fiber,
  Option,
  Runtime,
  type Scope,
  Stream,
} from "effect";
// VsCode.ts is the centralized service that wraps the VS Code API.
//
// All other modules should use type-only imports and access the API through this service.
//
// biome-ignore lint: See above
import * as vscode from "vscode";
import type { MarimoCommand, MarimoContextKey } from "../constants.ts";
import { tokenFromSignal } from "../utils/tokenFromSignal.ts";

export class VsCodeError extends Data.TaggedError("VsCodeError")<{
  cause: unknown;
}> {}

export class Window extends Effect.Service<Window>()("Window", {
  scoped: Effect.gen(function* () {
    const api = vscode.window;
    const runPromise = Runtime.runPromise(yield* Effect.runtime());

    return {
      showInputBox(
        options?: vscode.InputBoxOptions,
      ): Effect.Effect<Option.Option<string>> {
        return Effect.map(
          Effect.promise((signal) =>
            api.showInputBox(options, tokenFromSignal(signal)),
          ),
          Option.fromNullable,
        );
      },
      showInformationMessage<T extends string>(
        message: string,
        options: vscode.MessageOptions & { items?: readonly T[] } = {},
      ) {
        const { items = [], ...rest } = options;
        return Effect.map(
          Effect.promise(() =>
            api.showInformationMessage(message, rest, ...items),
          ),
          Option.fromNullable,
        );
      },
      showWarningMessage<T extends string>(
        message: string,
        options: vscode.MessageOptions & { items?: readonly T[] } = {},
      ) {
        const { items = [], ...rest } = options;
        return Effect.map(
          Effect.promise(() => api.showWarningMessage(message, rest, ...items)),
          Option.fromNullable,
        );
      },
      showErrorMessage<T extends string>(
        message: string,
        options: vscode.MessageOptions & { items?: readonly T[] } = {},
      ) {
        const { items = [], ...rest } = options;
        return Effect.map(
          Effect.promise(() => api.showErrorMessage(message, rest, ...items)),
          Option.fromNullable,
        );
      },
      showQuickPick(
        items: readonly string[],
        options: Omit<vscode.QuickPickOptions, "canPickMany"> = {},
      ) {
        return Effect.map(
          Effect.promise((signal) =>
            api.showQuickPick(items, options, tokenFromSignal(signal)),
          ),
          Option.fromNullable,
        );
      },
      showQuickPickItems<T extends vscode.QuickPickItem>(
        items: readonly T[],
        options: Omit<vscode.QuickPickOptions, "canPickMany"> = {},
      ) {
        return Effect.map(
          Effect.promise((signal) =>
            api.showQuickPick(items, options, tokenFromSignal(signal)),
          ),
          Option.fromNullable,
        );
      },
      createOutputChannel(name: string) {
        return Effect.acquireRelease(
          Effect.sync(() => api.createOutputChannel(name, { log: true })),
          (disposable) => Effect.sync(() => disposable.dispose()),
        );
      },
      getActiveNotebookEditor() {
        return Effect.succeed(Option.fromNullable(api.activeNotebookEditor));
      },
      getVisibleNotebookEditors() {
        return Effect.succeed(api.visibleNotebookEditors);
      },
      getActiveTextEditor() {
        return Effect.succeed(Option.fromNullable(api.activeTextEditor));
      },
      createTreeView<T>(viewId: string, options: vscode.TreeViewOptions<T>) {
        return Effect.acquireRelease(
          Effect.sync(() => api.createTreeView(viewId, options)),
          (disposable) => Effect.sync(() => disposable.dispose()),
        );
      },
      createStatusBarItem(
        id: string,
        alignment: vscode.StatusBarAlignment,
        priority?: number,
      ) {
        return Effect.acquireRelease(
          Effect.sync(() => api.createStatusBarItem(id, alignment, priority)),
          (disposable) => Effect.sync(() => disposable.dispose()),
        );
      },
      activeNotebookEditorChanges(): Stream.Stream<
        Option.Option<vscode.NotebookEditor>
      > {
        return Stream.asyncPush((emit) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              api.onDidChangeActiveNotebookEditor((e) =>
                emit.single(Option.fromNullable(e)),
              ),
            ),
            (disposable) => Effect.sync(() => disposable.dispose()),
          ),
        );
      },
      activeTextEditorChanges(): Stream.Stream<
        Option.Option<vscode.TextEditor>
      > {
        return Stream.asyncPush((emit) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              api.onDidChangeActiveTextEditor((e) =>
                emit.single(Option.fromNullable(e)),
              ),
            ),
            (disposable) => Effect.sync(() => disposable.dispose()),
          ),
        );
      },
      showNotebookDocument(
        doc: vscode.NotebookDocument,
        options?: vscode.NotebookDocumentShowOptions,
      ) {
        return Effect.promise(() => api.showNotebookDocument(doc, options));
      },
      withProgress(
        options: {
          location: vscode.ProgressLocation;
          title: string;
          cancellable: boolean;
        },
        fn: (
          progress: vscode.Progress<{
            message: string;
            increment?: number;
          }>,
        ) => Effect.Effect<void>,
      ) {
        return Effect.promise((signal) =>
          api.withProgress(options, (progress, token) =>
            runPromise(
              Effect.gen(function* () {
                const fiber = yield* Effect.forkScoped(fn(progress));
                const kill = () => runPromise(Fiber.interrupt(fiber));
                yield* Effect.acquireRelease(
                  Effect.sync(() => token.onCancellationRequested(kill)),
                  (disposable) => Effect.sync(() => disposable.dispose()),
                );
                yield* Fiber.join(fiber);
              }).pipe(Effect.scoped),
              { signal },
            ),
          ),
        );
      },
    };
  }),
}) {}

type ExecutableCommand =
  | "workbench.action.reloadWindow"
  | "workbench.action.openSettings"
  | "notebook.cell.execute"
  | "vscode.openWith"
  | MarimoCommand;

type ContextMap = {
  "marimo.notebook.hasStaleCells": boolean;
  "marimo.config.runtime.on_cell_change": "autorun" | "lazy";
  "marimo.isPythonFileMarimoNotebook": boolean;
};

export class Commands extends Effect.Service<Commands>()("Commands", {
  dependencies: [Window.Default],
  scoped: Effect.gen(function* () {
    const win = yield* Window;
    const api = vscode.commands;
    const runPromise = Runtime.runPromise(yield* Effect.runtime());

    return {
      executeCommand(command: ExecutableCommand, ...args: unknown[]) {
        return Effect.promise(() => api.executeCommand(command, ...args));
      },
      setContext<K extends MarimoContextKey>(key: K, value: ContextMap[K]) {
        return Effect.promise(() =>
          api.executeCommand("setContext", key, value),
        );
      },
      registerCommand(command: MarimoCommand, effect: Effect.Effect<void>) {
        return Effect.acquireRelease(
          Effect.sync(() =>
            api.registerCommand(command, () =>
              runPromise(
                effect.pipe(
                  Effect.catchAllCause((cause) =>
                    Effect.gen(function* () {
                      yield* Effect.logError(cause);
                      yield* win.showWarningMessage(
                        `Something went wrong in ${JSON.stringify(command)}. See marimo logs for more info.`,
                      );
                    }),
                  ),
                ),
              ),
            ),
          ),
          (disposable) => Effect.sync(() => disposable.dispose()),
        ).pipe(Effect.andThen(Effect.void));
      },
    };
  }),
}) {}

export class Workspace extends Effect.Service<Workspace>()("Workspace", {
  sync: () => {
    const api = vscode.workspace;
    return {
      getNotebookDocuments() {
        return Effect.succeed(api.notebookDocuments);
      },
      getConfiguration(section: string) {
        return Effect.succeed(api.getConfiguration(section));
      },
      getWorkspaceFolders() {
        return Effect.succeed(Option.fromNullable(api.workspaceFolders));
      },
      registerNotebookSerializer(
        notebookType: string,
        impl: vscode.NotebookSerializer,
      ) {
        return Effect.acquireRelease(
          Effect.sync(() => api.registerNotebookSerializer(notebookType, impl)),
          (disposable) => Effect.sync(() => disposable.dispose()),
        ).pipe(Effect.andThen(Effect.void));
      },
      notebookDocumentChanges() {
        return Stream.asyncPush<vscode.NotebookDocumentChangeEvent>((emit) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              api.onDidChangeNotebookDocument((evt) => emit.single(evt)),
            ),
            (disposable) => Effect.sync(() => disposable.dispose()),
          ),
        );
      },
      applyEdit(edit: vscode.WorkspaceEdit) {
        return Effect.promise(() => api.applyEdit(edit));
      },
      openNotebookDocument(uri: vscode.Uri) {
        return Effect.promise(() => api.openNotebookDocument(uri));
      },
      openUntitledNotebookDocument(
        notebookType: string,
        content?: vscode.NotebookData,
      ) {
        return Effect.promise(() =>
          api.openNotebookDocument(notebookType, content),
        );
      },
    };
  },
}) {}

export class Env extends Effect.Service<Env>()("Env", {
  sync: () => {
    const api = vscode.env;
    return {
      openExternal(target: vscode.Uri): Effect.Effect<boolean> {
        return Effect.promise(() => api.openExternal(target));
      },
    };
  },
}) {}

export class Debug extends Effect.Service<Debug>()("Debug", {
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

export class Notebooks extends Effect.Service<Notebooks>()("Notebooks", {
  effect: Effect.sync(() => {
    const api = vscode.notebooks;
    return {
      createRendererMessaging(rendererId: string) {
        return Effect.succeed(api.createRendererMessaging(rendererId));
      },
      createNotebookController(
        id: string,
        notebookType: string,
        label: string,
      ): Effect.Effect<
        Omit<vscode.NotebookController, "dispose">,
        never,
        Scope.Scope
      > {
        return Effect.acquireRelease(
          Effect.sync(() =>
            api.createNotebookController(id, notebookType, label),
          ),
          (disposable) => Effect.sync(() => disposable.dispose()),
        );
      },
      registerNotebookCellStatusBarItemProvider(
        notebookType: string,
        provider: vscode.NotebookCellStatusBarItemProvider,
      ) {
        return Effect.acquireRelease(
          Effect.sync(() =>
            api.registerNotebookCellStatusBarItemProvider(
              notebookType,
              provider,
            ),
          ),
          (disposable) => Effect.sync(() => disposable.dispose()),
        );
      },
    };
  }),
}) {}

export class AuthError extends Data.TaggedError("AuthError")<{
  cause: unknown;
}> {}

export class Auth extends Effect.Service<Auth>()("Auth", {
  effect: Effect.gen(function* () {
    const api = vscode.authentication;
    return {
      getSession(
        providerId: "github" | "microsoft", // could be custom but these are default
        scopes: ReadonlyArray<string>,
        options: vscode.AuthenticationGetSessionOptions,
      ) {
        return Effect.map(
          Effect.tryPromise({
            try: () => api.getSession(providerId, scopes, options),
            catch: (cause) => new AuthError({ cause }),
          }),
          Option.fromNullable,
        );
      },
    };
  }),
}) {}

export class ParseUriError extends Data.TaggedError("ParseUriError")<{
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
      NotebookEdit: vscode.NotebookEdit,
      NotebookCellStatusBarItem: vscode.NotebookCellStatusBarItem,
      NotebookCellStatusBarAlignment: vscode.NotebookCellStatusBarAlignment,
      WorkspaceEdit: vscode.WorkspaceEdit,
      EventEmitter: vscode.EventEmitter,
      DebugAdapterInlineImplementation: vscode.DebugAdapterInlineImplementation,
      ProgressLocation: vscode.ProgressLocation,
      ThemeIcon: vscode.ThemeIcon,
      TreeItem: vscode.TreeItem,
      TreeItemCollapsibleState: vscode.TreeItemCollapsibleState,
      ThemeColor: vscode.ThemeColor,
      StatusBarAlignment: vscode.StatusBarAlignment,
      Uri: vscode.Uri,
      MarkdownString: vscode.MarkdownString,
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
