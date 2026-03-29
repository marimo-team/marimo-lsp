import {
  Cause,
  Data,
  Effect,
  Either,
  Exit,
  Fiber,
  Option,
  PubSub,
  Runtime,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
// VsCode.ts centralizes and restricts access to the VS Code API.
//
// All other modules should use type-only imports and access the API through this service.
//
// We only expose the APIs we actually need. Being selective gives us a cleaner,
// easier testing story. The goal is NOT to hide APIs that are hard to mock,
// but to limit surface area to what's necessary for correctness and clarity.
//
// oxlint-disable-next-line marimo/vscode-type-only"
import * as vscode from "vscode";

import type { DynamicCommand, VscodeBuiltinCommand } from "../commands.ts";
import type { MarimoCommand, MarimoContextKey } from "../constants.ts";
import { acquireDisposable } from "../utils/acquireDisposable.ts";
import { signalFromToken } from "../utils/signalFromToken.ts";
import { tokenFromSignal } from "../utils/tokenFromSignal.ts";

export class VsCodeError extends Data.TaggedError("VsCodeError")<{
  cause: unknown;
}> { }

export class FileSystemError extends Data.TaggedError("FileSystemError")<{
  cause: unknown;
}> { }

export class DebugSessionStartError extends Data.TaggedError(
  "DebugSessionStartError",
)<{
  readonly configuration: string | vscode.DebugConfiguration;
}> { }

export class Window extends Effect.Service<Window>()("Window", {
  effect: Effect.gen(function*() {
    const api = vscode.window;

    const resolve = (kind: vscode.ColorThemeKind): "light" | "dark" =>
      kind === vscode.ColorThemeKind.Dark ||
        kind === vscode.ColorThemeKind.HighContrast
        ? "dark"
        : "light";

    const colorThemeRef = yield* SubscriptionRef.make(
      resolve(api.activeColorTheme.kind),
    );
    api.onDidChangeActiveColorTheme((theme) => {
      Effect.runSync(SubscriptionRef.set(colorThemeRef, resolve(theme.kind)));
    });

    return {
      createTerminal(
        options: vscode.TerminalOptions,
      ): Effect.Effect<
        Pick<vscode.Terminal, "show" | "sendText">,
        never,
        Scope.Scope
      > {
        return acquireDisposable(() => api.createTerminal(options));
      },
      showSaveDialog(options?: vscode.SaveDialogOptions) {
        return Effect.map(
          Effect.promise(() => api.showSaveDialog(options)),
          Option.fromNullable,
        );
      },
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
        return acquireDisposable(() => api.createOutputChannel(name));
      },
      createLogOutputChannel(name: string) {
        return acquireDisposable(() =>
          api.createOutputChannel(name, { log: true }),
        );
      },
      getActiveNotebookEditor() {
        return Effect.succeed(Option.fromNullable(api.activeNotebookEditor));
      },
      getVisibleNotebookEditors() {
        return Effect.succeed(api.visibleNotebookEditors);
      },
      getVisibleTextEditors() {
        return Effect.succeed(api.visibleTextEditors);
      },
      getActiveTextEditor() {
        return Effect.succeed(Option.fromNullable(api.activeTextEditor));
      },
      closeTextEditorTab(uri: vscode.Uri) {
        return Option.fromNullable(
          api.tabGroups.all
            .flatMap((group) => group.tabs)
            .find(
              (tab) =>
                tab.input instanceof vscode.TabInputText &&
                tab.input.uri.toString() === uri.toString(),
            ),
        ).pipe(
          Option.match({
            onSome: (tab) => Effect.promise(() => api.tabGroups.close(tab)),
            onNone: () => Effect.void,
          }),
        );
      },
      createTreeView<T>(viewId: string, options: vscode.TreeViewOptions<T>) {
        return acquireDisposable(() => api.createTreeView(viewId, options));
      },
      createStatusBarItem(
        id: string,
        alignment: vscode.StatusBarAlignment,
        priority?: number,
      ) {
        return acquireDisposable(() =>
          api.createStatusBarItem(id, alignment, priority),
        );
      },
      colorThemeChanges(): Stream.Stream<"light" | "dark"> {
        return colorThemeRef.changes;
      },
      activeNotebookEditorChanges(): Stream.Stream<
        Option.Option<vscode.NotebookEditor>
      > {
        return Stream.asyncPush((emit) =>
          acquireDisposable(() =>
            api.onDidChangeActiveNotebookEditor((e) =>
              emit.single(Option.fromNullable(e)),
            ),
          ),
        );
      },
      visibleNotebookEditorsChanges(): Stream.Stream<
        ReadonlyArray<vscode.NotebookEditor>
      > {
        return Stream.asyncPush((emit) =>
          acquireDisposable(() =>
            api.onDidChangeVisibleNotebookEditors((e) => emit.single(e)),
          ),
        );
      },
      visibleTextEditorsChanges(): Stream.Stream<
        ReadonlyArray<vscode.TextEditor>
      > {
        return Stream.asyncPush((emit) =>
          acquireDisposable(() =>
            api.onDidChangeVisibleTextEditors((e) => emit.single(e)),
          ),
        );
      },
      activeTextEditorChanges(): Stream.Stream<
        Option.Option<vscode.TextEditor>
      > {
        return Stream.asyncPush((emit) =>
          acquireDisposable(() =>
            api.onDidChangeActiveTextEditor((e) =>
              emit.single(Option.fromNullable(e)),
            ),
          ),
        );
      },
      showNotebookDocument(
        doc: vscode.NotebookDocument,
        options?: vscode.NotebookDocumentShowOptions,
      ) {
        return Effect.promise(() => api.showNotebookDocument(doc, options));
      },
      showTextDocument(doc: vscode.TextDocument) {
        // Could return the vscode.TextEditor, but skipping it simplifies mocks/tests
        return Effect.asVoid(Effect.promise(() => api.showTextDocument(doc)));
      },
      withProgress<A, E, R>(
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
        ) => Effect.Effect<A, E, R>,
      ) {
        return Effect.gen(function*() {
          const runPromise = Runtime.runPromise(yield* Effect.runtime<R>());
          yield* Effect.promise((signal) =>
            api.withProgress(options, (progress, token) =>
              runPromise(
                Effect.gen(function*() {
                  const fiber = yield* Effect.forkScoped(fn(progress));
                  const kill = () => runPromise(Fiber.interrupt(fiber));
                  yield* acquireDisposable(() =>
                    token.onCancellationRequested(kill),
                  );
                  yield* Fiber.join(fiber);
                }).pipe(Effect.scoped),
                { signal },
              ),
            ),
          );
        });
      },
    };
  }),
}) { }

type ExecutableCommand = VscodeBuiltinCommand | MarimoCommand | DynamicCommand;

type ContextMap = {
  "marimo.config.runtime.on_cell_change": "autorun" | "lazy";
  "marimo.config.runtime.auto_reload": "off" | "lazy" | "autorun";
  "marimo.isPythonFileMarimoNotebook": boolean;
  "marimo.notebook.hasStaleCells": boolean;
  "marimo.notebook.hasKernel": boolean;
};

export class Commands extends Effect.Service<Commands>()("Commands", {
  dependencies: [Window.Default],
  scoped: Effect.gen(function*() {
    const win = yield* Window;
    const api = vscode.commands;
    // Pubsub of the commands run and their results
    // Left is the command that failed, right is the command that succeeded
    const commandPubSub =
      yield* PubSub.unbounded<Either.Either<string, string>>();

    return {
      subscribeToCommands() {
        return PubSub.subscribe(commandPubSub);
      },
      executeCommand(command: ExecutableCommand, ...args: unknown[]) {
        return Effect.promise(() => api.executeCommand(command, ...args));
      },
      setContext<K extends MarimoContextKey>(key: K, value: ContextMap[K]) {
        return Effect.promise(() =>
          api.executeCommand("setContext", key, value),
        );
      },
      registerCommand<A, E, R>(
        command: MarimoCommand | DynamicCommand,
        fn: () => Effect.Effect<A, E, R>,
      ) {
        return Effect.gen(function*() {
          const runPromise = Runtime.runPromise(yield* Effect.runtime<R>());
          const callback = () =>
            fn().pipe(
              Effect.tap(() =>
                PubSub.publish(commandPubSub, Either.right(command)),
              ),
              Effect.catchAllCause(
                Effect.fn(function*(cause) {
                  // Skip logging for interruptions/cancellations (e.g., user
                  // cancels a progress dialog, VS Code disposes resources
                  // during kernel restart). These are expected and not errors.
                  if (
                    Cause.isInterruptedOnly(cause) ||
                    [...Cause.defects(cause)].some(
                      (defect: unknown) =>
                        defect instanceof Error && defect.name === "Canceled",
                    )
                  ) {
                    yield* PubSub.publish(commandPubSub, Either.left(command));
                    return;
                  }
                  yield* Effect.logError(cause);
                  yield* PubSub.publish(commandPubSub, Either.left(command));
                  yield* win.showWarningMessage(
                    `Something went wrong in ${JSON.stringify(command)}. See marimo logs for more info.`,
                  );
                }),
              ),
              runPromise,
            );

          yield* acquireDisposable(() =>
            api.registerCommand(command, callback),
          );
        });
      },
    };
  }),
}) { }

export class Workspace extends Effect.Service<Workspace>()("Workspace", {
  sync: () => {
    const api = vscode.workspace;
    return {
      fs: {
        readFile(uri: vscode.Uri) {
          return Effect.tryPromise({
            try: () => api.fs.readFile(uri),
            catch: (cause) => new FileSystemError({ cause }),
          });
        },
        writeFile(uri: vscode.Uri, contents: Uint8Array) {
          return Effect.tryPromise({
            try: () => api.fs.writeFile(uri, contents),
            catch: (cause) => new FileSystemError({ cause }),
          });
        },
      },
      getNotebookDocuments() {
        return Effect.succeed(api.notebookDocuments);
      },
      getConfiguration(section: string, scope?: vscode.ConfigurationScope) {
        return Effect.succeed(api.getConfiguration(section, scope));
      },
      getWorkspaceFolders() {
        return Effect.succeed(Option.fromNullable(api.workspaceFolders));
      },
      isTrusted() {
        return api.isTrusted;
      },
      registerNotebookSerializer(
        notebookType: string,
        impl: vscode.NotebookSerializer,
        options?: vscode.NotebookDocumentContentOptions,
      ) {
        return acquireDisposable(() =>
          api.registerNotebookSerializer(notebookType, impl, options),
        ).pipe(Effect.andThen(Effect.void));
      },
      notebookDocumentChanges() {
        return Stream.asyncPush<vscode.NotebookDocumentChangeEvent>((emit) =>
          acquireDisposable(() =>
            api.onDidChangeNotebookDocument((event) => emit.single(event)),
          ),
        );
      },
      notebookDocumentOpened() {
        return Stream.asyncPush<vscode.NotebookDocument>((emit) =>
          acquireDisposable(() =>
            api.onDidOpenNotebookDocument((event) => emit.single(event)),
          ),
        );
      },
      textDocumentChanges() {
        return Stream.asyncPush<vscode.TextDocumentChangeEvent>((emit) =>
          acquireDisposable(() =>
            api.onDidChangeTextDocument((event) => emit.single(event)),
          ),
        );
      },
      notebookDocumentClosed() {
        return Stream.asyncPush<vscode.NotebookDocument>((emit) =>
          acquireDisposable(() =>
            api.onDidCloseNotebookDocument((event) => emit.single(event)),
          ),
        );
      },
      configurationChanges() {
        return Stream.asyncPush<vscode.ConfigurationChangeEvent>((emit) =>
          acquireDisposable(() =>
            api.onDidChangeConfiguration((event) => emit.single(event)),
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
      openUntitledTextDocument(options: {
        content?: string;
        language?: string;
      }) {
        return Effect.promise(() => api.openTextDocument(options));
      },
      createFileSystemWatcher(globPattern: string) {
        return api.createFileSystemWatcher(globPattern);
      },
    };
  },
}) { }

export class Env extends Effect.Service<Env>()("Env", {
  sync: () => {
    const api = vscode.env;
    return {
      appName: api.appName,
      appRoot: api.appRoot,
      appHost: api.appHost,
      machineId: api.machineId,
      openExternal(target: vscode.Uri): Effect.Effect<boolean> {
        return Effect.promise(() => api.openExternal(target));
      },
    };
  },
}) { }

export class Debug extends Effect.Service<Debug>()("Debug", {
  effect: Effect.sync(() => {
    const api = vscode.debug;
    return {
      registerDebugConfigurationProvider(
        debugType: string,
        factory: vscode.DebugConfigurationProvider,
      ) {
        return acquireDisposable(() =>
          api.registerDebugConfigurationProvider(debugType, factory),
        ).pipe(Effect.asVoid);
      },
      registerDebugAdapterDescriptorFactory<R = never>(
        debugType: string,
        factory: {
          createDebugAdapter(
            session: vscode.DebugSession,
            executable: vscode.DebugAdapterExecutable | undefined,
          ): Effect.Effect<
            Option.Option<Omit<vscode.DebugAdapter, "dispose">>,
            never,
            Scope.Scope | R
          >;
        },
      ): Effect.Effect<void, never, Scope.Scope | R> {
        return Effect.gen(function*() {
          const runPromise = Runtime.runPromise(yield* Effect.runtime<R>());

          yield* acquireDisposable(() =>
            api.registerDebugAdapterDescriptorFactory(debugType, {
              createDebugAdapterDescriptor: (session, executable) =>
                runPromise(
                  Effect.gen(function*() {
                    const scope = yield* Scope.make();
                    const adapter = yield* factory
                      .createDebugAdapter(session, executable)
                      .pipe(Scope.extend(scope));

                    if (Option.isNone(adapter)) {
                      yield* Scope.close(scope, Exit.void);
                      return null;
                    }

                    return new vscode.DebugAdapterInlineImplementation(
                      Object.assign(adapter.value, {
                        dispose: () =>
                          Effect.runFork(Scope.close(scope, Exit.void)),
                      }),
                    );
                  }),
                ),
            }),
          );
        });
      },
      startDebugging(
        folder: vscode.WorkspaceFolder | undefined,
        nameOrConfiguration: string | vscode.DebugConfiguration,
      ) {
        return Effect.tryPromise({
          try: () => api.startDebugging(folder, nameOrConfiguration),
          catch: (cause) => new VsCodeError({ cause }),
        }).pipe(
          Effect.filterOrFail(
            (success) => success,
            () =>
              new DebugSessionStartError({
                configuration: nameOrConfiguration,
              }),
          ),
          Effect.asVoid,
        );
      },
      stopDebugging(sessionId?: string) {
        // Find the session by ID if provided, otherwise stop all
        const session = sessionId
          ? vscode.debug.activeDebugSession?.id === sessionId
            ? vscode.debug.activeDebugSession
            : undefined
          : undefined;
        return Effect.promise(() => api.stopDebugging(session));
      },
      onDidTerminateDebugSession(
        listener: (session: vscode.DebugSession) => Effect.Effect<void>,
      ) {
        return acquireDisposable(() =>
          api.onDidTerminateDebugSession((session) => {
            void Effect.runPromise(listener(session));
          }),
        ).pipe(Effect.asVoid);
      },
    };
  }),
}) { }

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
        return acquireDisposable(() =>
          api.createNotebookController(id, notebookType, label),
        );
      },
      registerNotebookCellStatusBarItemProvider(
        notebookType: string,
        provider: vscode.NotebookCellStatusBarItemProvider,
      ) {
        return acquireDisposable(() =>
          api.registerNotebookCellStatusBarItemProvider(notebookType, provider),
        );
      },
    };
  }),
}) { }

export class AuthError extends Data.TaggedError("AuthError")<{
  cause: unknown;
}> { }

export class Auth extends Effect.Service<Auth>()("Auth", {
  effect: Effect.sync(() => {
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
}) { }

export class Languages extends Effect.Service<Languages>()("Langauges", {
  effect: Effect.gen(function*() {
    const api = vscode.languages;
    const runPromise = Runtime.runPromise(yield* Effect.runtime());
    return {
      // TODO make effectful
      registerCodeLensProvider(
        selector: vscode.DocumentSelector,
        provider: vscode.CodeLensProvider,
      ) {
        return acquireDisposable(() =>
          api.registerCodeLensProvider(selector, provider),
        ).pipe(Effect.asVoid);
      },
      createDiagnosticCollection(name: string) {
        return api.createDiagnosticCollection(name);
      },
      registerHoverProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideHover(
            doc: vscode.TextDocument,
            pos: vscode.Position,
          ): Effect.Effect<vscode.Hover | undefined>;
        },
      ) {
        return acquireDisposable(() =>
          api.registerHoverProvider(selector, {
            provideHover(doc, pos, tok) {
              return runPromise(impl.provideHover(doc, pos), {
                signal: signalFromToken(tok),
              });
            },
          }),
        );
      },
    };
  }),
}) { }

export class ParseUriError extends Data.TaggedError("ParseUriError")<{
  cause: unknown;
}> { }

/**
 * Wraps VS Code API functionality in Effect services
 */
export class VsCode extends Effect.Service<VsCode>()("VsCode", {
  effect: Effect.gen(function*() {
    // Expose the raw vscode module for runtime inspection via --inspect-extensions.
    // Only active when MARIMO_DEBUG=1 (set by launch-dev.sh).
    if (process.env.MARIMO_DEBUG === "1") {
      (globalThis as any).__marimoVsCode = vscode;
    }

    return {
      // namespaces
      window: yield* Window,
      commands: yield* Commands,
      workspace: yield* Workspace,
      env: yield* Env,
      debug: yield* Debug,
      notebooks: yield* Notebooks,
      auth: yield* Auth,
      languages: yield* Languages,
      Diagnostic: vscode.Diagnostic,
      Hover: vscode.Hover,
      CompletionTriggerKind: vscode.CompletionTriggerKind,
      CompletionItem: vscode.CompletionItem,
      CompletionList: vscode.CompletionList,
      MarkdownString: vscode.MarkdownString,
      SignatureInformation: vscode.SignatureInformation,
      ParameterInformation: vscode.ParameterInformation,
      CodeLens: vscode.CodeLens,
      SemanticTokensLegend: vscode.SemanticTokensLegend,
      SemanticTokens: vscode.SemanticTokens,
      // data types
      NotebookData: vscode.NotebookData,
      NotebookCellData: vscode.NotebookCellData,
      NotebookCellKind: vscode.NotebookCellKind,
      NotebookCellOutput: vscode.NotebookCellOutput,
      NotebookCellOutputItem: vscode.NotebookCellOutputItem,
      NotebookEditorRevealType: vscode.NotebookEditorRevealType,
      NotebookEdit: vscode.NotebookEdit,
      NotebookRange: vscode.NotebookRange,
      NotebookCellStatusBarItem: vscode.NotebookCellStatusBarItem,
      NotebookControllerAffinity: vscode.NotebookControllerAffinity,
      NotebookCellStatusBarAlignment: vscode.NotebookCellStatusBarAlignment,
      WorkspaceEdit: vscode.WorkspaceEdit,
      Position: vscode.Position,
      EventEmitter: vscode.EventEmitter,
      DebugAdapterInlineImplementation: vscode.DebugAdapterInlineImplementation,
      ProgressLocation: vscode.ProgressLocation,
      ThemeIcon: vscode.ThemeIcon,
      TreeItem: vscode.TreeItem,
      TreeItemCollapsibleState: vscode.TreeItemCollapsibleState,
      ThemeColor: vscode.ThemeColor,
      StatusBarAlignment: vscode.StatusBarAlignment,
      Location: vscode.Location,
      Uri: vscode.Uri,
      Range: vscode.Range,
      version: vscode.version,
      extensions: {
        getExtension<T = unknown>(extensionId: string) {
          return Option.fromNullable(
            vscode.extensions.getExtension<T>(extensionId),
          );
        },
      },
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
}) { }
