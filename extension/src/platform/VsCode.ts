import {
  Context,
  Data,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Queue,
  Result,
  type Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";

declare global {
  // oxlint-disable-next-line eslint/no-var, eslint/no-underscore-dangle
  var __marimoVsCode: typeof vscode | undefined;
}
// VsCode.ts centralizes and restricts access to the VS Code API.
//
// All other modules should use type-only imports and access the API through this service.
//
// We only expose the APIs we actually need. Being selective gives us a cleaner,
// easier testing story. The goal is NOT to hide APIs that are hard to mock,
// but to limit surface area to what's necessary for correctness and clarity.
//
// oxlint-disable-next-line marimo/vscode-type-only
import * as vscode from "vscode";

import {
  type CommandArguments,
  type CommandDefinition,
  commandId,
  decodeCommandArguments,
  decodeCommandResult,
  type MarimoCommand,
  type VscodeBuiltinCommand,
  type VscodeCommandArgs,
  type VscodeCommandResult,
} from "../commands.ts";
import type { MarimoContextKey } from "../constants.ts";
import { acquireDisposable } from "../lib/acquireDisposable.ts";
import { isExpectedCancellation } from "../lib/isExpectedCancellation.ts";
import { signalFromToken } from "../lib/signalFromToken.ts";
import { tokenFromSignal } from "../lib/tokenFromSignal.ts";

type ActiveNotebookEditorSource = Pick<
  typeof vscode.window,
  "activeNotebookEditor" | "onDidChangeActiveNotebookEditor"
>;

/** Subscribe before sampling so an already-active editor cannot be missed. */
export const makeActiveNotebookEditorChanges = (
  source: ActiveNotebookEditorSource,
): Stream.Stream<Option.Option<vscode.NotebookEditor>> =>
  Stream.callback<Option.Option<vscode.NotebookEditor>>((queue) =>
    acquireDisposable(() => {
      const subscription = source.onDidChangeActiveNotebookEditor((editor) =>
        Queue.offerUnsafe(queue, Option.fromNullishOr(editor)),
      );
      Queue.offerUnsafe(
        queue,
        Option.fromNullishOr(source.activeNotebookEditor),
      );
      return subscription;
    }),
  );

export class VsCodeError extends Data.TaggedError("VsCodeError")<{
  cause: unknown;
}> {}

export class FileSystemError extends Data.TaggedError("FileSystemError")<{
  cause: unknown;
}> {}

export class DebugSessionStartError extends Data.TaggedError(
  "DebugSessionStartError",
)<{
  readonly configuration: string | vscode.DebugConfiguration;
}> {}

export class Window extends Context.Service<Window>()("Window", {
  make: Effect.gen(function* () {
    const api = vscode.window;
    const runSync = Effect.runSyncWith(yield* Effect.context());

    const resolve = (kind: vscode.ColorThemeKind): "light" | "dark" =>
      kind === vscode.ColorThemeKind.Dark ||
      kind === vscode.ColorThemeKind.HighContrast
        ? "dark"
        : "light";

    const colorThemeRef = yield* SubscriptionRef.make(
      resolve(api.activeColorTheme.kind),
    );
    api.onDidChangeActiveColorTheme((theme) => {
      runSync(SubscriptionRef.set(colorThemeRef, resolve(theme.kind)));
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
          Option.fromNullishOr,
        );
      },
      showInputBox(
        options?: vscode.InputBoxOptions,
      ): Effect.Effect<Option.Option<string>> {
        return Effect.map(
          Effect.promise((signal) =>
            api.showInputBox(options, tokenFromSignal(signal)),
          ),
          Option.fromNullishOr,
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
          Option.fromNullishOr,
        );
      },
      showWarningMessage<T extends string>(
        message: string,
        options: vscode.MessageOptions & { items?: readonly T[] } = {},
      ) {
        const { items = [], ...rest } = options;
        return Effect.map(
          Effect.promise(() => api.showWarningMessage(message, rest, ...items)),
          Option.fromNullishOr,
        );
      },
      showErrorMessage<T extends string>(
        message: string,
        options: vscode.MessageOptions & { items?: readonly T[] } = {},
      ) {
        const { items = [], ...rest } = options;
        return Effect.map(
          Effect.promise(() => api.showErrorMessage(message, rest, ...items)),
          Option.fromNullishOr,
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
          Option.fromNullishOr,
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
          Option.fromNullishOr,
        );
      },
      showQuickPickItemsMany<T extends vscode.QuickPickItem>(
        items: readonly T[],
        options: Omit<vscode.QuickPickOptions, "canPickMany"> = {},
      ) {
        return Effect.map(
          Effect.promise((signal) =>
            api.showQuickPick(
              items,
              { ...options, canPickMany: true },
              tokenFromSignal(signal),
            ),
          ),
          Option.fromNullishOr,
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
      getActiveNotebookEditor: Effect.sync(() =>
        Option.fromNullishOr(api.activeNotebookEditor),
      ),
      getVisibleNotebookEditors: Effect.sync(() => api.visibleNotebookEditors),
      getVisibleTextEditors: Effect.sync(() => api.visibleTextEditors),
      getActiveTextEditor: Effect.sync(() =>
        Option.fromNullishOr(api.activeTextEditor),
      ),
      closeTextEditorTab(uri: vscode.Uri) {
        return Option.fromNullishOr(
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
      colorThemeChanges: SubscriptionRef.changes(colorThemeRef),
      activeNotebookEditorChanges: makeActiveNotebookEditorChanges(api),
      visibleNotebookEditorsChanges: Stream.callback<
        ReadonlyArray<vscode.NotebookEditor>
      >((queue) =>
        acquireDisposable(() =>
          api.onDidChangeVisibleNotebookEditors((e) =>
            Queue.offerUnsafe(queue, e),
          ),
        ),
      ),
      visibleTextEditorsChanges: Stream.callback<
        ReadonlyArray<vscode.TextEditor>
      >((queue) =>
        acquireDisposable(() =>
          api.onDidChangeVisibleTextEditors((e) => Queue.offerUnsafe(queue, e)),
        ),
      ),
      activeTextEditorChanges: Stream.callback<
        Option.Option<vscode.TextEditor>
      >((queue) =>
        acquireDisposable(() =>
          api.onDidChangeActiveTextEditor((e) =>
            Queue.offerUnsafe(queue, Option.fromNullishOr(e)),
          ),
        ),
      ),
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
        return Effect.gen(function* () {
          const context = yield* Effect.context<R>();
          const runPromise = Effect.runPromiseWith(context);
          return yield* Effect.promise((signal) =>
            api.withProgress(options, (progress, token) =>
              runPromise(
                Effect.gen(function* () {
                  const fiber = yield* Effect.forkScoped(fn(progress));
                  const kill = () => runPromise(Fiber.interrupt(fiber));
                  yield* acquireDisposable(() =>
                    token.onCancellationRequested(kill),
                  );
                  return yield* Fiber.join(fiber);
                }).pipe(Effect.scoped),
                { signal },
              ),
            ),
          );
        });
      },
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

type ContextMap = {
  "marimo.hasLiveSessions": boolean;
  "marimo.config.runtime.on_cell_change": "autorun" | "lazy";
  "marimo.config.runtime.auto_reload": "off" | "lazy" | "autorun";
  "marimo.isPythonFileMarimoNotebook": boolean;
  "marimo.notebook.hasStaleCells": boolean;
  "marimo.notebook.hasKernel": boolean;
};

export const withCommandContext = (command: MarimoCommand) => {
  const wireId = commandId(command);
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapCause((cause) =>
        isExpectedCancellation(cause) ? Effect.void : Effect.logError(cause),
      ),
      Effect.annotateLogs({
        "command.id": wireId,
      }),
    );
};

export class Commands extends Context.Service<Commands>()("Commands", {
  make: Effect.gen(function* () {
    const win = yield* Window;
    const api = vscode.commands;
    // Pubsub of the commands run and their results
    // Failure is the command that failed, success is the command that succeeded
    const commandPubSub =
      yield* PubSub.unbounded<Result.Result<string, string>>();

    function execute<
      CallArgs extends CommandArguments,
      HandlerArgs extends CommandArguments,
      Result,
      DecodeRequirements,
    >(
      command: MarimoCommand<CallArgs, HandlerArgs, Result, DecodeRequirements>,
      ...args: CallArgs
    ): Effect.Effect<Result, Schema.SchemaError> {
      return Effect.promise(() =>
        api.executeCommand(commandId(command), ...args),
      ).pipe(Effect.flatMap((result) => decodeCommandResult(command, result)));
    }

    function executeVSCode<C extends VscodeBuiltinCommand>(
      command: C,
      ...args: VscodeCommandArgs<C>
    ): Effect.Effect<VscodeCommandResult<C>> {
      return Effect.promise(() =>
        api.executeCommand<VscodeCommandResult<C>>(command, ...args),
      );
    }

    function registerImplementation<A, E, R>(
      wireId: string,
      invoke: (args: ReadonlyArray<unknown>) => Effect.Effect<A, E, R>,
    ) {
      return Effect.gen(function* () {
        const runPromise = Effect.runPromiseWith(yield* Effect.context<R>());
        const callback = (...args: unknown[]) =>
          invoke(args).pipe(
            Effect.tap(() =>
              PubSub.publish(commandPubSub, Result.succeed(wireId)),
            ),
            Effect.catchCause(
              Effect.fn(function* (cause) {
                // Skip logging for interruptions/cancellations (e.g., user
                // cancels a progress dialog, VS Code disposes resources
                // during kernel restart). These are expected and not errors.
                if (isExpectedCancellation(cause)) {
                  yield* PubSub.publish(commandPubSub, Result.fail(wireId));
                  return;
                }
                yield* PubSub.publish(commandPubSub, Result.fail(wireId));
                yield* win.showWarningMessage(
                  `Something went wrong in ${JSON.stringify(wireId)}. See marimo logs for more info.`,
                );
              }),
            ),
            runPromise,
          );

        yield* acquireDisposable(() => api.registerCommand(wireId, callback));
      });
    }

    function register<
      CallArgs extends CommandArguments,
      HandlerArgs extends CommandArguments,
      Result,
      DecodeRequirements,
      E,
      HandlerRequirements,
    >(
      definition: CommandDefinition<
        CallArgs,
        HandlerArgs,
        Result,
        DecodeRequirements,
        E,
        HandlerRequirements
      >,
    ) {
      const { command, invoke } = definition;
      const wireId = commandId(command);
      return registerImplementation(wireId, (args) =>
        decodeCommandArguments(command, args).pipe(
          Effect.flatMap((decoded) => invoke(...decoded)),
          Effect.flatMap((result) => decodeCommandResult(command, result)),
          withCommandContext(command),
        ),
      );
    }

    function bind<
      CallArgs extends CommandArguments,
      HandlerArgs extends CommandArguments,
      Result,
      DecodeRequirements,
    >(
      command: MarimoCommand<CallArgs, HandlerArgs, Result, DecodeRequirements>,
      title: string,
      ...args: CallArgs
    ): vscode.Command {
      return {
        command: commandId(command),
        title,
        arguments: [...args],
      };
    }

    return {
      subscribeToCommands: PubSub.subscribe(commandPubSub),
      execute,
      executeVSCode,
      bind,
      setContext<K extends MarimoContextKey>(key: K, value: ContextMap[K]) {
        return Effect.promise(() =>
          api.executeCommand("setContext", key, value),
        );
      },
      register,
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Window.layer),
  );
}

export interface NotebookLifecycleEvent {
  readonly type: "opened" | "closed";
  readonly document: vscode.NotebookDocument;
}

type NotebookLifecycleSource = Pick<
  typeof vscode.workspace,
  | "notebookDocuments"
  | "onDidOpenNotebookDocument"
  | "onDidCloseNotebookDocument"
>;

/**
 * Subscribe before taking the initial snapshot, then release both listeners
 * with the stream's consumer. The enclosing scope is a fallback when the
 * consumer never starts or remains active until extension shutdown.
 */
export const makeNotebookLifecycle = Effect.fn("makeNotebookLifecycle")(
  function* (source: NotebookLifecycleSource) {
    const queue = yield* Queue.make<NotebookLifecycleEvent>();
    const [opened, closed] = yield* Effect.sync(() => {
      const opened = source.onDidOpenNotebookDocument((document) =>
        Queue.offerUnsafe(queue, { type: "opened", document }),
      );
      try {
        return [
          opened,
          source.onDidCloseNotebookDocument((document) =>
            Queue.offerUnsafe(queue, { type: "closed", document }),
          ),
        ] as const;
      } catch (error) {
        opened.dispose();
        throw error;
      }
    });

    let stopped = false;
    const stop = Effect.suspend(() => {
      if (stopped) return Effect.void;
      stopped = true;
      return Effect.sync(() => {
        opened.dispose();
        closed.dispose();
      }).pipe(Effect.andThen(Queue.shutdown(queue)));
    });
    yield* Effect.addFinalizer(() => stop);

    Queue.offerAllUnsafe(
      queue,
      source.notebookDocuments.map((document) => ({
        type: "opened" as const,
        document,
      })),
    );
    return Stream.fromQueue(queue).pipe(Stream.ensuring(stop));
  },
);

export class Workspace extends Context.Service<Workspace>()("Workspace", {
  make: Effect.sync(() => {
    const api = vscode.workspace;
    return {
      fs: {
        createDirectory(uri: vscode.Uri) {
          return Effect.tryPromise({
            try: () => api.fs.createDirectory(uri),
            catch: (cause) => new FileSystemError({ cause }),
          });
        },
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
      getNotebookDocuments: Effect.sync(() => api.notebookDocuments),
      getTextDocuments: Effect.sync(() => api.textDocuments),
      getConfiguration(section: string, scope?: vscode.ConfigurationScope) {
        return Effect.succeed(api.getConfiguration(section, scope));
      },
      getWorkspaceFolders: Effect.sync(() =>
        Option.fromNullishOr(api.workspaceFolders),
      ),
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
      notebookDocumentChanges:
        Stream.callback<vscode.NotebookDocumentChangeEvent>((queue) =>
          acquireDisposable(() =>
            api.onDidChangeNotebookDocument((event) =>
              Queue.offerUnsafe(queue, event),
            ),
          ),
        ),
      notebookDocumentOpened: Stream.callback<vscode.NotebookDocument>(
        (queue) =>
          acquireDisposable(() =>
            api.onDidOpenNotebookDocument((event) =>
              Queue.offerUnsafe(queue, event),
            ),
          ),
      ),
      // Everything here — both listener registrations and the snapshot of
      // already-open documents — runs before the effect completes, within one
      // fiber turn, so no event can fall between snapshot and subscription. A
      // document may be observed twice (snapshot and event) but never zero
      // times; consumers must treat a re-observed open as idempotent.
      subscribeNotebookLifecycle: makeNotebookLifecycle(api),
      textDocumentChanges: Stream.callback<vscode.TextDocumentChangeEvent>(
        (queue) =>
          acquireDisposable(() =>
            api.onDidChangeTextDocument((event) =>
              Queue.offerUnsafe(queue, event),
            ),
          ),
      ),
      notebookDocumentClosed: Stream.callback<vscode.NotebookDocument>(
        (queue) =>
          acquireDisposable(() =>
            api.onDidCloseNotebookDocument((event) =>
              Queue.offerUnsafe(queue, event),
            ),
          ),
      ),
      fileRenames: Stream.callback<vscode.FileRenameEvent>((queue) =>
        acquireDisposable(() =>
          api.onDidRenameFiles((event) => Queue.offerUnsafe(queue, event)),
        ),
      ),
      fileDeletes: Stream.callback<vscode.FileDeleteEvent>((queue) =>
        acquireDisposable(() =>
          api.onDidDeleteFiles((event) => Queue.offerUnsafe(queue, event)),
        ),
      ),
      configurationChanges: Stream.callback<vscode.ConfigurationChangeEvent>(
        (queue) =>
          acquireDisposable(() =>
            api.onDidChangeConfiguration((event) =>
              Queue.offerUnsafe(queue, event),
            ),
          ),
      ),
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
      createFileSystemWatcher(globPattern: vscode.GlobPattern) {
        return Stream.callback<{ uri: vscode.Uri; type: 1 | 2 | 3 }>((queue) =>
          acquireDisposable(() => {
            const watcher = api.createFileSystemWatcher(globPattern);
            watcher.onDidCreate((uri) =>
              Queue.offerUnsafe(queue, { uri, type: 1 }),
            );
            watcher.onDidChange((uri) =>
              Queue.offerUnsafe(queue, { uri, type: 2 }),
            );
            watcher.onDidDelete((uri) =>
              Queue.offerUnsafe(queue, { uri, type: 3 }),
            );
            return watcher;
          }),
        );
      },
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export class Env extends Context.Service<Env>()("Env", {
  make: Effect.sync(() => {
    const api = vscode.env;
    return {
      appName: api.appName,
      appRoot: api.appRoot,
      appHost: api.appHost,
      machineId: api.machineId,
      createTelemetryLogger(
        sender: vscode.TelemetrySender,
        options?: vscode.TelemetryLoggerOptions,
      ) {
        return acquireDisposable(() =>
          api.createTelemetryLogger(sender, options),
        );
      },
      openExternal(target: vscode.Uri): Effect.Effect<boolean> {
        return Effect.promise(() => api.openExternal(target));
      },
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export class Debug extends Context.Service<Debug>()("Debug", {
  make: Effect.sync(() => {
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
        return Effect.gen(function* () {
          const context = yield* Effect.context<R>();
          const runPromise = Effect.runPromiseWith(context);
          const runFork = Effect.runForkWith(context);

          yield* acquireDisposable(() =>
            api.registerDebugAdapterDescriptorFactory(debugType, {
              createDebugAdapterDescriptor: (session, executable) =>
                runPromise(
                  Effect.gen(function* () {
                    const scope = yield* Scope.make();
                    const adapter = yield* factory
                      .createDebugAdapter(session, executable)
                      .pipe(Scope.provide(scope));

                    if (Option.isNone(adapter)) {
                      yield* Scope.close(scope, Exit.void);
                      return null;
                    }

                    return new vscode.DebugAdapterInlineImplementation(
                      Object.assign(adapter.value, {
                        dispose: () => runFork(Scope.close(scope, Exit.void)),
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
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export class Notebooks extends Context.Service<Notebooks>()("Notebooks", {
  make: Effect.gen(function* () {
    const api = vscode.notebooks;
    const runPromise = Effect.runPromiseWith(yield* Effect.context());
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
        impl: {
          provideCellStatusBarItems(
            cell: vscode.NotebookCell,
          ): Effect.Effect<vscode.NotebookCellStatusBarItem[]>;
          changes: Stream.Stream<void>;
        },
      ) {
        return Effect.gen(function* () {
          const emitter = yield* acquireDisposable(
            () => new vscode.EventEmitter<void>(),
          );
          yield* Effect.forkScoped(
            impl.changes.pipe(
              Stream.runForEach(() => Effect.succeed(emitter.fire())),
            ),
          );
          yield* acquireDisposable(() =>
            api.registerNotebookCellStatusBarItemProvider(notebookType, {
              onDidChangeCellStatusBarItems: emitter.event,
              provideCellStatusBarItems: (cell, token) =>
                runPromise(impl.provideCellStatusBarItems(cell), {
                  signal: signalFromToken(token),
                }),
            }),
          );
        });
      },
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export class AuthError extends Data.TaggedError("AuthError")<{
  cause: unknown;
}> {}

export class Auth extends Context.Service<Auth>()("Auth", {
  make: Effect.sync(() => {
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
          Option.fromNullishOr,
        );
      },
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export class Languages extends Context.Service<Languages>()("Languages", {
  make: Effect.gen(function* () {
    const api = vscode.languages;
    const runPromise = Effect.runPromiseWith(yield* Effect.context());
    return {
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
        ).pipe(Effect.asVoid);
      },
      registerDefinitionProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideDefinition(
            doc: vscode.TextDocument,
            pos: vscode.Position,
          ): Effect.Effect<
            vscode.Definition | vscode.DefinitionLink[] | undefined
          >;
        },
      ) {
        return acquireDisposable(() =>
          api.registerDefinitionProvider(selector, {
            provideDefinition(doc, pos, tok) {
              return runPromise(impl.provideDefinition(doc, pos), {
                signal: signalFromToken(tok),
              });
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerDeclarationProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideDeclaration(
            doc: vscode.TextDocument,
            pos: vscode.Position,
          ): Effect.Effect<
            vscode.Declaration | vscode.LocationLink[] | undefined
          >;
        },
      ) {
        return acquireDisposable(() =>
          api.registerDeclarationProvider(selector, {
            provideDeclaration(doc, pos, tok) {
              return runPromise(impl.provideDeclaration(doc, pos), {
                signal: signalFromToken(tok),
              });
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerTypeDefinitionProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideTypeDefinition(
            doc: vscode.TextDocument,
            pos: vscode.Position,
          ): Effect.Effect<
            vscode.Definition | vscode.DefinitionLink[] | undefined
          >;
        },
      ) {
        return acquireDisposable(() =>
          api.registerTypeDefinitionProvider(selector, {
            provideTypeDefinition(doc, pos, tok) {
              return runPromise(impl.provideTypeDefinition(doc, pos), {
                signal: signalFromToken(tok),
              });
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerReferenceProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideReferences(
            doc: vscode.TextDocument,
            pos: vscode.Position,
            ctx: vscode.ReferenceContext,
          ): Effect.Effect<vscode.Location[]>;
        },
      ) {
        return acquireDisposable(() =>
          api.registerReferenceProvider(selector, {
            provideReferences(doc, pos, ctx, tok) {
              return runPromise(impl.provideReferences(doc, pos, ctx), {
                signal: signalFromToken(tok),
              });
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerDocumentHighlightProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideDocumentHighlights(
            doc: vscode.TextDocument,
            pos: vscode.Position,
          ): Effect.Effect<vscode.DocumentHighlight[]>;
        },
      ) {
        return acquireDisposable(() =>
          api.registerDocumentHighlightProvider(selector, {
            provideDocumentHighlights(doc, pos, tok) {
              return runPromise(impl.provideDocumentHighlights(doc, pos), {
                signal: signalFromToken(tok),
              });
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerDocumentSymbolProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideDocumentSymbols(
            doc: vscode.TextDocument,
          ): Effect.Effect<vscode.DocumentSymbol[]>;
        },
      ) {
        return acquireDisposable(() =>
          api.registerDocumentSymbolProvider(selector, {
            provideDocumentSymbols(doc, tok) {
              return runPromise(impl.provideDocumentSymbols(doc), {
                signal: signalFromToken(tok),
              });
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerFoldingRangeProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideFoldingRanges(
            doc: vscode.TextDocument,
          ): Effect.Effect<vscode.FoldingRange[]>;
        },
      ) {
        return acquireDisposable(() =>
          api.registerFoldingRangeProvider(selector, {
            provideFoldingRanges(doc, _ctx, tok) {
              return runPromise(impl.provideFoldingRanges(doc), {
                signal: signalFromToken(tok),
              });
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerSelectionRangeProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideSelectionRanges(
            doc: vscode.TextDocument,
            positions: readonly vscode.Position[],
          ): Effect.Effect<vscode.SelectionRange[]>;
        },
      ) {
        return acquireDisposable(() =>
          api.registerSelectionRangeProvider(selector, {
            provideSelectionRanges(doc, positions, tok) {
              return runPromise(impl.provideSelectionRanges(doc, positions), {
                signal: signalFromToken(tok),
              });
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerDocumentFormattingEditProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideDocumentFormattingEdits(
            doc: vscode.TextDocument,
            opts: vscode.FormattingOptions,
          ): Effect.Effect<vscode.TextEdit[]>;
        },
      ) {
        return acquireDisposable(() =>
          api.registerDocumentFormattingEditProvider(selector, {
            provideDocumentFormattingEdits(doc, opts, tok) {
              return runPromise(
                impl.provideDocumentFormattingEdits(doc, opts),
                { signal: signalFromToken(tok) },
              );
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerDocumentRangeFormattingEditProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideDocumentRangeFormattingEdits(
            doc: vscode.TextDocument,
            range: vscode.Range,
            opts: vscode.FormattingOptions,
          ): Effect.Effect<vscode.TextEdit[]>;
        },
      ) {
        return acquireDisposable(() =>
          api.registerDocumentRangeFormattingEditProvider(selector, {
            provideDocumentRangeFormattingEdits(doc, range, opts, tok) {
              return runPromise(
                impl.provideDocumentRangeFormattingEdits(doc, range, opts),
                { signal: signalFromToken(tok) },
              );
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerSignatureHelpProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideSignatureHelp(
            doc: vscode.TextDocument,
            pos: vscode.Position,
          ): Effect.Effect<vscode.SignatureHelp | undefined>;
        },
        metadata: vscode.SignatureHelpProviderMetadata | string[],
      ) {
        return acquireDisposable(() => {
          if (Array.isArray(metadata)) {
            return api.registerSignatureHelpProvider(
              selector,
              {
                provideSignatureHelp(doc, pos, tok) {
                  return runPromise(impl.provideSignatureHelp(doc, pos), {
                    signal: signalFromToken(tok),
                  });
                },
              },
              ...metadata,
            );
          }
          return api.registerSignatureHelpProvider(
            selector,
            {
              provideSignatureHelp(doc, pos, tok) {
                return runPromise(impl.provideSignatureHelp(doc, pos), {
                  signal: signalFromToken(tok),
                });
              },
            },
            metadata,
          );
        }).pipe(Effect.asVoid);
      },
      registerInlayHintsProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideInlayHints(
            doc: vscode.TextDocument,
            range: vscode.Range,
          ): Effect.Effect<vscode.InlayHint[]>;
          resolveInlayHint?: (
            hint: vscode.InlayHint,
          ) => Effect.Effect<vscode.InlayHint>;
        },
      ) {
        return acquireDisposable(() =>
          api.registerInlayHintsProvider(selector, {
            provideInlayHints(doc, range, tok) {
              return runPromise(impl.provideInlayHints(doc, range), {
                signal: signalFromToken(tok),
              });
            },
            resolveInlayHint: impl.resolveInlayHint
              ? (
                  (resolve) => (hint, tok) =>
                    runPromise(resolve(hint), {
                      signal: signalFromToken(tok),
                    })
                )(impl.resolveInlayHint)
              : undefined,
          }),
        ).pipe(Effect.asVoid);
      },
      registerCompletionItemProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideCompletionItems(
            doc: vscode.TextDocument,
            pos: vscode.Position,
            ctx: vscode.CompletionContext,
          ): Effect.Effect<vscode.CompletionItem[]>;
          resolveCompletionItem?: (
            item: vscode.CompletionItem,
          ) => Effect.Effect<vscode.CompletionItem>;
        },
        triggerCharacters: string[],
      ) {
        return acquireDisposable(() =>
          api.registerCompletionItemProvider(
            selector,
            {
              provideCompletionItems(doc, pos, tok, ctx) {
                return runPromise(impl.provideCompletionItems(doc, pos, ctx), {
                  signal: signalFromToken(tok),
                });
              },
              resolveCompletionItem: impl.resolveCompletionItem
                ? (
                    (resolve) => (item, tok) =>
                      runPromise(resolve(item), {
                        signal: signalFromToken(tok),
                      })
                  )(impl.resolveCompletionItem)
                : undefined,
            },
            ...triggerCharacters,
          ),
        ).pipe(Effect.asVoid);
      },
      registerCodeActionsProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideCodeActions(
            doc: vscode.TextDocument,
            range: vscode.Range,
            ctx: vscode.CodeActionContext,
          ): Effect.Effect<vscode.CodeAction[]>;
          resolveCodeAction?: (
            item: vscode.CodeAction,
          ) => Effect.Effect<vscode.CodeAction>;
        },
        metadata: vscode.CodeActionProviderMetadata | undefined,
      ) {
        return acquireDisposable(() =>
          api.registerCodeActionsProvider(
            selector,
            {
              provideCodeActions(doc, range, ctx, tok) {
                return runPromise(impl.provideCodeActions(doc, range, ctx), {
                  signal: signalFromToken(tok),
                });
              },
              resolveCodeAction: impl.resolveCodeAction
                ? (
                    (resolve) => (item, tok) =>
                      runPromise(resolve(item), {
                        signal: signalFromToken(tok),
                      })
                  )(impl.resolveCodeAction)
                : undefined,
            },
            metadata,
          ),
        ).pipe(Effect.asVoid);
      },
      registerRenameProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideRenameEdits(
            doc: vscode.TextDocument,
            pos: vscode.Position,
            newName: string,
          ): Effect.Effect<vscode.WorkspaceEdit | undefined>;
          prepareRename?: (
            doc: vscode.TextDocument,
            pos: vscode.Position,
          ) => Effect.Effect<
            | vscode.Range
            | { range: vscode.Range; placeholder: string }
            | undefined
          >;
        },
      ) {
        return acquireDisposable(() =>
          api.registerRenameProvider(selector, {
            provideRenameEdits(doc, pos, newName, tok) {
              return runPromise(impl.provideRenameEdits(doc, pos, newName), {
                signal: signalFromToken(tok),
              });
            },
            prepareRename: impl.prepareRename
              ? (
                  (prepare) => (doc, pos, tok) =>
                    runPromise(prepare(doc, pos), {
                      signal: signalFromToken(tok),
                    })
                )(impl.prepareRename)
              : undefined,
          }),
        ).pipe(Effect.asVoid);
      },
      registerDocumentSemanticTokensProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideDocumentSemanticTokens(
            doc: vscode.TextDocument,
          ): Effect.Effect<vscode.SemanticTokens | undefined>;
        },
        legend: vscode.SemanticTokensLegend,
      ) {
        return acquireDisposable(() =>
          api.registerDocumentSemanticTokensProvider(
            selector,
            {
              provideDocumentSemanticTokens(doc, tok) {
                return runPromise(impl.provideDocumentSemanticTokens(doc), {
                  signal: signalFromToken(tok),
                });
              },
            },
            legend,
          ),
        ).pipe(Effect.asVoid);
      },
      registerDocumentRangeSemanticTokensProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideDocumentRangeSemanticTokens(
            doc: vscode.TextDocument,
            range: vscode.Range,
          ): Effect.Effect<vscode.SemanticTokens | undefined>;
        },
        legend: vscode.SemanticTokensLegend,
      ) {
        return acquireDisposable(() =>
          api.registerDocumentRangeSemanticTokensProvider(
            selector,
            {
              provideDocumentRangeSemanticTokens(doc, range, tok) {
                return runPromise(
                  impl.provideDocumentRangeSemanticTokens(doc, range),
                  { signal: signalFromToken(tok) },
                );
              },
            },
            legend,
          ),
        ).pipe(Effect.asVoid);
      },
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export class ParseUriError extends Data.TaggedError("ParseUriError")<{
  cause: unknown;
}> {}

/**
 * Wraps VS Code API functionality in Effect services
 */
export class VsCode extends Context.Service<VsCode>()("VsCode", {
  make: Effect.gen(function* () {
    // Expose the raw vscode module for runtime inspection via --inspect-extensions.
    // Only active when MARIMO_DEBUG=1 (set by launch-dev.sh).
    if (process.env.MARIMO_DEBUG === "1") {
      // oxlint-disable-next-line eslint/no-underscore-dangle
      globalThis.__marimoVsCode = vscode;
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
      DiagnosticSeverity: vscode.DiagnosticSeverity,
      CodeActionTriggerKind: vscode.CodeActionTriggerKind,
      Hover: vscode.Hover,
      TextEdit: vscode.TextEdit,
      SignatureHelp: vscode.SignatureHelp,
      InlayHint: vscode.InlayHint,
      InlayHintLabelPart: vscode.InlayHintLabelPart,
      SnippetString: vscode.SnippetString,
      CodeAction: vscode.CodeAction,
      CodeActionKind: vscode.CodeActionKind,
      CompletionTriggerKind: vscode.CompletionTriggerKind,
      CompletionItem: vscode.CompletionItem,
      CompletionItemKind: vscode.CompletionItemKind,
      CompletionList: vscode.CompletionList,
      MarkdownString: vscode.MarkdownString,
      SignatureInformation: vscode.SignatureInformation,
      ParameterInformation: vscode.ParameterInformation,
      CodeLens: vscode.CodeLens,
      DocumentHighlight: vscode.DocumentHighlight,
      DocumentSymbol: vscode.DocumentSymbol,
      FoldingRange: vscode.FoldingRange,
      SelectionRange: vscode.SelectionRange,
      SemanticTokensLegend: vscode.SemanticTokensLegend,
      SemanticTokens: vscode.SemanticTokens,
      LanguageModelToolResult: vscode.LanguageModelToolResult,
      LanguageModelTextPart: vscode.LanguageModelTextPart,
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
      RelativePattern: vscode.RelativePattern,
      version: vscode.version,
      extensions: {
        getExtension<T = unknown>(extensionId: string) {
          return Option.fromNullishOr(
            vscode.extensions.getExtension<T>(extensionId),
          );
        },
      },
      // Language Model (agent tools). Inline like `extensions` — one method.
      lm: {
        /**
         * Register a language-model tool; unregistered when the surrounding
         * scope closes. The tool's `invoke`/`prepareInvocation` are built by
         * the caller (which owns the runtime to run any Effects).
         */
        registerTool<T>(name: string, tool: vscode.LanguageModelTool<T>) {
          return Effect.asVoid(
            acquireDisposable(() => vscode.lm.registerTool(name, tool)),
          );
        },
      },
      // helper
      utils: {
        parseUri(value: string) {
          return Result.try({
            try: () => vscode.Uri.parse(value, /* strict*/ true),
            catch: (cause) => new ParseUriError({ cause }),
          });
        },
      },
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([
      Window.layer,
      Workspace.layer,
      Commands.layer,
      Env.layer,
      Debug.layer,
      Notebooks.layer,
      Auth.layer,
      Languages.layer,
    ]),
  );
}
