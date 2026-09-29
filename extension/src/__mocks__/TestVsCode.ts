import {
  Context,
  Data,
  Deferred,
  Effect,
  HashSet,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Result,
  Stream,
  SubscriptionRef,
} from "effect";
import type * as vscode from "vscode";

import { commandId, decodeCommandResult } from "../commands.ts";
import { acquireDisposable } from "../lib/acquireDisposable.ts";
import * as Commands from "../platform/Commands.ts";
import * as Env from "../platform/Env.ts";
import * as VsCode from "../platform/VsCode.ts";
import * as Window from "../platform/Window.ts";
import * as Workspace from "../platform/Workspace.ts";
import type { RendererCommand, RendererReceiveMessage } from "../types.ts";
import {
  NotebookCellData,
  NotebookData,
  NotebookCellOutput,
  NotebookCellOutputItem,
  NotebookRange,
  LanguageModelTextPart,
  LanguageModelToolResult,
  NotebookEdit,
  NotebookCellStatusBarItem,
  Uri,
  Position,
  Range,
  RelativePattern,
  CodeLens,
  SemanticTokensLegend,
  SemanticTokens,
  TextEdit,
  WorkspaceEdit,
  EventEmitter,
  ThemeColor,
  ThemeIcon,
  MarkdownString,
  TreeItem,
  TextDocument,
  NotebookDocument,
  closeNotebookDocument,
  CompletionItem,
  CompletionList,
  Location,
  Hover,
  DocumentHighlight,
  DocumentSymbol,
  FoldingRange,
  SelectionRange,
  CodeActionKind,
  CodeAction,
  SnippetString,
  InlayHintLabelPart,
  InlayHint,
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  Diagnostic,
  DiagnosticCollection,
} from "./VsCodeValues.ts";

export * from "./VsCodeValues.ts";

export interface Options {
  readonly initialDocuments?: Array<vscode.NotebookDocument>;
  readonly initialActiveNotebookEditor?: Option.Option<vscode.NotebookEditor>;
  readonly initialActiveTextEditor?: Option.Option<vscode.TextEditor>;
  readonly visibleNotebookEditors?: Array<vscode.NotebookEditor>;
  readonly version?: string;
  readonly fileSystem?: Map<string, Uint8Array | Error>;
  readonly installedExtensions?: ReadonlyArray<string>;
}

/** One-test scripts for behavior that the standard controls cannot express. */
export interface Behavior {
  readonly window?: Partial<Window.Interface>;
  readonly commands?: Partial<Commands.Interface>;
  readonly workspace?: Partial<Workspace.Interface>;
  readonly env?: Partial<Env.Interface>;
}

interface NotebookState {
  readonly documents: ReadonlyArray<vscode.NotebookDocument>;
  readonly active: Option.Option<vscode.NotebookEditor>;
  readonly visible: ReadonlyArray<vscode.NotebookEditor>;
}

export interface InputRequest {
  readonly options: vscode.InputBoxOptions | undefined;
  readonly status: "pending" | "responded" | "cancelled";
}

export interface CommandExecution {
  readonly command: string;
  readonly args: ReadonlyArray<unknown>;
}

export interface AffinityUpdate {
  readonly controllerId: string;
  readonly notebookUri: string;
  readonly affinity: vscode.NotebookControllerAffinity;
}

export interface RegisteredSerializer {
  readonly notebookType: string;
  readonly serializer: vscode.NotebookSerializer;
  readonly options: vscode.NotebookDocumentContentOptions | undefined;
}

export interface RegisteredStatusBarProvider {
  readonly notebookType: string;
  readonly provideCellStatusBarItems: (
    cell: vscode.NotebookCell,
  ) => Effect.Effect<vscode.NotebookCellStatusBarItem[]>;
}

export interface QuickPickItem {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
}

export interface QuickPickRequest {
  readonly items: ReadonlyArray<QuickPickItem>;
  readonly title: string | undefined;
  readonly canPickMany: boolean;
}

type QuickPickResponse = Data.TaggedEnum<{
  Single: { readonly label: string };
  Many: { readonly labels: ReadonlyArray<string> };
}>;
const QuickPickResponse = Data.taggedEnum<QuickPickResponse>();

export interface Snapshot {
  readonly inputs: ReadonlyArray<InputRequest>;
  readonly views: ReadonlyArray<string>;
  readonly commands: ReadonlyArray<string>;
  readonly serializers: ReadonlyArray<string>;
  readonly controllers: ReadonlyArray<string>;
  readonly executions: ReadonlyArray<CommandExecution>;
  readonly affinityUpdates: ReadonlyArray<AffinityUpdate>;
  readonly openedExternalUris: ReadonlyArray<string>;
  readonly workspaceEdits: ReadonlyArray<vscode.WorkspaceEdit>;
  readonly openNotebookUris: ReadonlyArray<string>;
  readonly activeNotebookUri: Option.Option<string>;
  readonly visibleNotebookUris: ReadonlyArray<string>;
  readonly quickPicks: ReadonlyArray<QuickPickRequest>;
  readonly informationMessages: ReadonlyArray<string>;
  readonly warningMessages: ReadonlyArray<string>;
  readonly errorMessages: ReadonlyArray<string>;
}

export interface Interface {
  readonly inputChanges: Stream.Stream<ReadonlyArray<InputRequest>>;
  readonly respondToInput: (
    value: Option.Option<string>,
  ) => Effect.Effect<void>;
  readonly snapshot: Effect.Effect<Snapshot>;
  readonly controllers: Effect.Effect<ReadonlyArray<vscode.NotebookController>>;
  readonly controllerChanges: Stream.Stream<
    ReadonlyArray<vscode.NotebookController>
  >;
  readonly affinityChanges: Stream.Stream<ReadonlyArray<AffinityUpdate>>;
  readonly serializers: Effect.Effect<ReadonlyArray<RegisteredSerializer>>;
  readonly statusBarProviders: Effect.Effect<
    ReadonlyArray<RegisteredStatusBarProvider>
  >;
  readonly openNotebook: (
    document: vscode.NotebookDocument,
  ) => Effect.Effect<void>;
  readonly closeNotebook: (
    document: vscode.NotebookDocument,
  ) => Effect.Effect<void>;
  readonly notebookChange: (
    event: vscode.NotebookDocumentChangeEvent,
  ) => Effect.Effect<boolean>;
  readonly setActiveNotebookEditor: (
    editor: Option.Option<vscode.NotebookEditor>,
  ) => Effect.Effect<void>;
  readonly setActiveTextEditor: (
    editor: Option.Option<vscode.TextEditor>,
  ) => Effect.Effect<void>;
  readonly selectQuickPick: (label: string) => Effect.Effect<void>;
  readonly selectQuickPickMany: (
    labels: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
  readonly selectInformationMessage: (item: string) => Effect.Effect<void>;
  readonly selectErrorMessage: (item: string) => Effect.Effect<void>;
  readonly configurationChange: (
    event: vscode.ConfigurationChangeEvent,
  ) => Effect.Effect<void>;
  readonly awaitExecutions: (
    predicate: (executions: ReadonlyArray<CommandExecution>) => boolean,
  ) => Effect.Effect<void>;
  readonly awaitInformationMessages: (count: number) => Effect.Effect<void>;
  readonly selectNotebookController: (
    controllerId: string,
    notebook: vscode.NotebookDocument,
    selected: boolean,
  ) => Effect.Effect<void>;
  readonly rendererMessaging: {
    readonly ready: Effect.Effect<void>;
    readonly send: (
      editor: vscode.NotebookEditor,
      message: RendererCommand,
    ) => Effect.Effect<void>;
    readonly receive: Effect.Effect<RendererReceiveMessage>;
  };
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/VsCode",
) {}

// One private model backs the production adapter and test controls. Mutable
// handles never leave this closure; callers observe snapshots and transitions.
const makeModel = Effect.fn(function* (options: Options, behavior: Behavior) {
  const initialText =
    options.initialActiveTextEditor ?? Option.none<vscode.TextEditor>();
  const textEditors = yield* SubscriptionRef.make({
    active: initialText,
    visible: Option.toArray(initialText),
  });
  const initialActive = options.initialActiveNotebookEditor ?? Option.none();
  const initialVisible = [
    ...new Set([
      ...(options.visibleNotebookEditors ?? []),
      ...Option.toArray(initialActive),
    ]),
  ];
  const notebooks = yield* SubscriptionRef.make<NotebookState>({
    documents: Array.from(
      new Map(
        [
          ...(options.initialDocuments ?? []),
          ...initialVisible.map((editor) => editor.notebook),
        ].map((document) => [document.uri.toString(), document]),
      ).values(),
    ),
    active: initialActive,
    visible: initialVisible,
  });

  const documentChanges =
    yield* PubSub.unbounded<vscode.NotebookDocumentChangeEvent>();

  const documentOpened = yield* PubSub.unbounded<vscode.NotebookDocument>();

  const documentClosed = yield* PubSub.unbounded<vscode.NotebookDocument>();

  const documentLifecycle =
    yield* PubSub.unbounded<Workspace.NotebookLifecycleEvent>();

  const commands = yield* Ref.make(HashSet.empty<string>());
  const controllers = yield* SubscriptionRef.make(
    HashSet.empty<vscode.NotebookController>(),
  );
  const controllerSelectionEmitters = new Map<
    string,
    EventEmitter<{
      notebook: vscode.NotebookDocument;
      selected: boolean;
    }>
  >();
  const rendererMessages = new EventEmitter<{
    editor: vscode.NotebookEditor;
    message: RendererCommand;
  }>();
  const rendererMessagingReady = yield* Deferred.make<void>();
  const rendererReplies = yield* Queue.unbounded<RendererReceiveMessage>();
  const serializers = yield* Ref.make(
    HashSet.empty<{
      notebookType: string;
      serializer: vscode.NotebookSerializer;
      options: vscode.NotebookDocumentContentOptions | undefined;
    }>(),
  );
  const statusBarProviders = yield* Ref.make<
    Array<{
      notebookType: string;
      provideCellStatusBarItems(
        cell: vscode.NotebookCell,
      ): Effect.Effect<vscode.NotebookCellStatusBarItem[]>;
    }>
  >([]);
  const views = yield* Ref.make(HashSet.empty<string>());

  const executions = yield* Ref.make<ReadonlyArray<CommandExecution>>([]);
  const executionRevision = yield* SubscriptionRef.make(0);

  const affinityUpdates = yield* SubscriptionRef.make<
    ReadonlyArray<AffinityUpdate>
  >([]);
  const openedExternalUris = yield* Ref.make<ReadonlyArray<string>>([]);
  const workspaceEdits = yield* Ref.make<ReadonlyArray<vscode.WorkspaceEdit>>(
    [],
  );
  const quickPicks = yield* Ref.make<ReadonlyArray<QuickPickRequest>>([]);
  const quickPickResponses = yield* Queue.unbounded<QuickPickResponse>();
  const inputResponses = yield* Queue.unbounded<Option.Option<string>>();
  const inputs = yield* SubscriptionRef.make<ReadonlyArray<InputRequest>>([]);
  const informationMessages = yield* Ref.make<ReadonlyArray<string>>([]);
  const informationMessageRevision = yield* SubscriptionRef.make(0);
  const warningMessages = yield* Ref.make<ReadonlyArray<string>>([]);
  const errorMessages = yield* Ref.make<ReadonlyArray<string>>([]);
  const informationMessageResponses = yield* Queue.unbounded<string>();
  const errorMessageResponses = yield* Queue.unbounded<string>();
  const configurationChanges =
    yield* PubSub.unbounded<vscode.ConfigurationChangeEvent>();

  const recordQuickPick = (
    items: ReadonlyArray<QuickPickItem>,
    title: string | undefined,
    canPickMany: boolean,
  ) =>
    Ref.update(quickPicks, (requests) => [
      ...requests,
      {
        items: items.map((item) => ({
          label: item.label,
          description: item.description,
          detail: item.detail,
        })),
        title,
        canPickMany,
      },
    ]);

  const takeQuickPickResponse = Queue.poll(quickPickResponses);

  const selectQuickPickItem = <T extends QuickPickItem>(
    items: ReadonlyArray<T>,
    title: string | undefined,
  ) =>
    Effect.gen(function* () {
      yield* recordQuickPick(items, title, false);
      const response = yield* takeQuickPickResponse;
      if (Option.isNone(response)) return Option.none<T>();
      const value = response.value;
      if (value._tag !== "Single") {
        return yield* Effect.die("Expected a single-item quick-pick response");
      }
      const selected = items.find((item) => item.label === value.label);
      if (selected === undefined) {
        return yield* Effect.die(`Quick-pick item not found: ${value.label}`);
      }
      return Option.some(selected);
    });

  const selectQuickPickItems = <T extends QuickPickItem>(
    items: ReadonlyArray<T>,
    title: string | undefined,
  ) =>
    Effect.gen(function* () {
      yield* recordQuickPick(items, title, true);
      const response = yield* takeQuickPickResponse;
      if (Option.isNone(response)) return Option.none<ReadonlyArray<T>>();
      if (response.value._tag !== "Many") {
        return yield* Effect.die("Expected a multi-item quick-pick response");
      }
      const selected: T[] = [];
      for (const label of response.value.labels) {
        const item = items.find((candidate) => candidate.label === label);
        if (item === undefined) {
          return yield* Effect.die(`Quick-pick item not found: ${label}`);
        }
        selected.push(item);
      }
      return Option.some(selected);
    });

  const context = yield* Effect.context();

  const commandResultsPubSub =
    yield* PubSub.unbounded<Result.Result<string, string>>();

  const layer = Layer.succeed(VsCode.Service, {
    // namespaces
    window: {
      showSaveDialog() {
        return Effect.succeed(Option.none());
      },
      showInputBox: (options) =>
        Effect.suspend(() => {
          const request: InputRequest = { options, status: "pending" };
          return SubscriptionRef.update(inputs, (current) => [
            ...current,
            request,
          ]).pipe(
            Effect.andThen(Queue.take(inputResponses)),
            Effect.tap(() =>
              SubscriptionRef.update(inputs, (current) =>
                current.map((item) =>
                  item === request ? { ...item, status: "responded" } : item,
                ),
              ),
            ),
            Effect.onInterrupt(() =>
              SubscriptionRef.update(inputs, (current) =>
                current.map((item) =>
                  item === request ? { ...item, status: "cancelled" } : item,
                ),
              ),
            ),
          );
        }),
      showInformationMessage:
        behavior.window?.showInformationMessage ??
        ((message, options = {}) =>
          Ref.update(informationMessages, (messages) => [
            ...messages,
            message,
          ]).pipe(
            Effect.andThen(
              SubscriptionRef.update(
                informationMessageRevision,
                (revision) => revision + 1,
              ),
            ),
            Effect.andThen(Queue.poll(informationMessageResponses)),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed(Option.none()),
                onSome: (selected) => {
                  const item = options.items?.find(
                    (candidate) => candidate === selected,
                  );
                  return item === undefined
                    ? Effect.die(
                        `Information-message item not found: ${selected}`,
                      )
                    : Effect.succeed(Option.some(item));
                },
              }),
            ),
          )),
      showWarningMessage:
        behavior.window?.showWarningMessage ??
        ((message) =>
          Ref.update(warningMessages, (messages) => [
            ...messages,
            message,
          ]).pipe(Effect.as(Option.none()))),
      showErrorMessage:
        behavior.window?.showErrorMessage ??
        ((message, options = {}) =>
          Ref.update(errorMessages, (messages) => [...messages, message]).pipe(
            Effect.andThen(Queue.poll(errorMessageResponses)),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed(Option.none()),
                onSome: (selected) => {
                  const item = options.items?.find(
                    (candidate) => candidate === selected,
                  );
                  return item === undefined
                    ? Effect.die(`Error-message item not found: ${selected}`)
                    : Effect.succeed(Option.some(item));
                },
              }),
            ),
          )),
      showQuickPick:
        behavior.window?.showQuickPick ??
        ((items, options) =>
          selectQuickPickItem(
            items.map((label) => ({ label })),
            options?.title,
          ).pipe(Effect.map(Option.map((item) => item.label)))),
      showQuickPickItems(items, options) {
        return selectQuickPickItem(items, options?.title);
      },
      showQuickPickItemsMany(items, options) {
        return selectQuickPickItems(items, options?.title);
      },
      createOutputChannel(name) {
        return Effect.succeed({
          name,
          dispose() {},
          append() {},
          appendLine() {},
          replace() {},
          clear() {},
          show() {},
          hide() {},
        });
      },
      createTerminal() {
        return Effect.succeed({
          sendText() {},
          show() {},
        });
      },
      createLogOutputChannel(name) {
        return acquireDisposable(() => {
          const emitter = new EventEmitter<vscode.LogLevel>();
          return {
            name,
            logLevel: 0,
            onDidChangeLogLevel: emitter.event,
            dispose() {
              emitter.dispose();
            },
            append() {},
            appendLine() {},
            replace() {},
            clear() {},
            show() {},
            hide() {},
            trace() {},
            debug() {},
            info() {},
            warn() {},
            error() {},
          };
        });
      },
      getVisibleNotebookEditors: Effect.map(
        SubscriptionRef.get(notebooks),
        (state) => state.visible,
      ),
      getVisibleTextEditors: Effect.map(
        SubscriptionRef.get(textEditors),
        (state) => state.visible,
      ),
      getActiveNotebookEditor: Effect.map(
        SubscriptionRef.get(notebooks),
        (state) => state.active,
      ),
      activeNotebookEditorChanges: SubscriptionRef.changes(notebooks).pipe(
        Stream.map((state) => state.active),
        Stream.changesWith((left, right) => left === right),
      ),
      visibleNotebookEditorsChanges: SubscriptionRef.changes(notebooks).pipe(
        Stream.map((state) => state.visible),
        Stream.changesWith((left, right) => left === right),
      ),
      visibleTextEditorsChanges: SubscriptionRef.changes(textEditors).pipe(
        Stream.map((state) => state.visible),
        Stream.changesWith((left, right) => left === right),
      ),
      getActiveTextEditor: Effect.map(
        SubscriptionRef.get(textEditors),
        (state) => state.active,
      ),
      // VS Code emits future active-editor changes; it does not replay the
      // editor returned by `getActiveTextEditor` when a listener subscribes.
      activeTextEditorChanges: SubscriptionRef.changes(textEditors).pipe(
        Stream.map((state) => state.active),
        Stream.changesWith((left, right) => left === right),
        Stream.drop(1),
      ),
      subscribeActiveTextEditorChanges: Effect.gen(function* () {
        const queue =
          yield* Queue.unbounded<Option.Option<vscode.TextEditor>>();
        yield* SubscriptionRef.changes(textEditors).pipe(
          Stream.map((state) => state.active),
          Stream.changesWith((left, right) => left === right),
          Stream.drop(1),
          Stream.runForEach((active) => Queue.offer(queue, active)),
          Effect.forkScoped({ startImmediately: true }),
        );
        return Stream.fromQueue(queue);
      }),
      colorThemeChanges:
        behavior.window?.colorThemeChanges ?? Stream.make("light" as const),
      closeTextEditorTab: () => Effect.void,
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-type-parameters
      createTreeView<T>(viewId: string) {
        return Effect.acquireRelease(
          Effect.gen(function* () {
            yield* Ref.update(views, HashSet.add(viewId));
            const expandElement = new EventEmitter<
              vscode.TreeViewExpansionEvent<T>
            >();
            const collapseElement = new EventEmitter<
              vscode.TreeViewExpansionEvent<T>
            >();
            const changeSelection = new EventEmitter<
              vscode.TreeViewSelectionChangeEvent<T>
            >();
            const changeVisibility =
              new EventEmitter<vscode.TreeViewVisibilityChangeEvent>();
            const changeCheckboxState = new EventEmitter<
              vscode.TreeCheckboxChangeEvent<T>
            >();
            return {
              onDidExpandElement: expandElement.event,
              onDidCollapseElement: collapseElement.event,
              selection: [],
              onDidChangeSelection: changeSelection.event,
              visible: false,
              onDidChangeVisibility: changeVisibility.event,
              onDidChangeCheckboxState: changeCheckboxState.event,
              async reveal(): Promise<void> {},
              dispose() {
                expandElement.dispose();
                collapseElement.dispose();
                changeSelection.dispose();
                changeVisibility.dispose();
                changeCheckboxState.dispose();
              },
            };
          }),
          (disposable) =>
            Effect.gen(function* () {
              yield* Ref.update(views, HashSet.remove(viewId));
              yield* Effect.sync(() => disposable.dispose());
            }),
        );
      },
      createStatusBarItem(
        id: string,
        alignment: vscode.StatusBarAlignment,
        priority?: number,
      ) {
        return acquireDisposable(() => ({
          id,
          alignment,
          priority,
          text: "",
          name: undefined,
          tooltip: undefined,
          color: undefined,
          backgroundColor: undefined,
          command: undefined,
          accessibilityInformation: undefined,
          show() {},
          hide() {},
          dispose() {},
        }));
      },
      showNotebookDocument(
        doc: vscode.NotebookDocument,
        options?: vscode.NotebookDocumentShowOptions,
      ) {
        return Effect.succeed({
          notebook: doc,
          visibleRanges: [],
          selection: new NotebookRange(0, 0),
          selections: options?.selections ?? [],
          viewColumn: options?.viewColumn,
          revealRange() {},
        });
      },
      showTextDocument() {
        return Effect.void;
      },
      withProgress(_options, fn) {
        return Effect.orDie(fn({ report() {} }));
      },
      ...behavior.window,
    },
    commands: {
      subscribeToCommands: PubSub.subscribe(commandResultsPubSub),
      setContext(key, value) {
        return Ref.update(executions, (arr) => [
          ...arr,
          { command: "setContext", args: [key, value] },
        ]).pipe(
          Effect.andThen(
            SubscriptionRef.update(
              executionRevision,
              (revision) => revision + 1,
            ),
          ),
        );
      },
      execute(command, ...args) {
        return Ref.update(executions, (arr) => [
          ...arr,
          { command: commandId(command), args },
        ]).pipe(
          Effect.andThen(
            SubscriptionRef.update(
              executionRevision,
              (revision) => revision + 1,
            ),
          ),
          Effect.andThen(decodeCommandResult(command, undefined)),
        );
      },
      executeVSCode(command, ...args) {
        return Ref.update(executions, (arr) => [
          ...arr,
          { command, args },
        ]).pipe(
          Effect.andThen(
            SubscriptionRef.update(
              executionRevision,
              (revision) => revision + 1,
            ),
          ),
        );
      },
      bind(command, title, ...args) {
        return {
          command: commandId(command),
          title,
          arguments: [...args],
        };
      },
      register(definition) {
        const name = commandId(definition.command);
        return Effect.gen(function* () {
          yield* Ref.update(commands, HashSet.add<string>(name));
          yield* Effect.addFinalizer(() =>
            Ref.update(commands, HashSet.remove<string>(name)),
          );
        });
      },
      ...behavior.commands,
    },
    workspace: {
      fs: {
        createDirectory() {
          return Effect.void;
        },
        readFile(uri: vscode.Uri) {
          const fileSystem: Map<string, Uint8Array | Error> =
            options.fileSystem ?? new Map();

          const key = uri.toString();
          const entry = fileSystem.get(key);

          if (entry instanceof Error) {
            return Effect.fail(new Workspace.FileSystemError({ cause: entry }));
          }

          if (entry !== undefined) {
            return Effect.succeed(entry);
          }

          // File not in map - return error for missing file
          return Effect.fail(
            new Workspace.FileSystemError({
              cause: new Error(`ENOENT: ${key}`),
            }),
          );
        },
        writeFile() {
          return Effect.succeed(true);
        },
      },
      getNotebookDocuments: Effect.map(
        SubscriptionRef.get(notebooks),
        (state) => Array.from(state.documents),
      ),
      getTextDocuments: Effect.map(SubscriptionRef.get(textEditors), (state) =>
        state.visible.map((editor) => editor.document),
      ),
      configurationChanges: Stream.fromPubSub(configurationChanges),
      getConfiguration() {
        return Effect.succeed({
          get: () => undefined,
          has: () => false,
          inspect: () => undefined,
          async update() {},
        });
      },
      getWorkspaceFolders: Effect.succeed(Option.none()),
      isTrusted() {
        return true;
      },
      registerNotebookSerializer(notebookType, impl, options) {
        return Effect.acquireRelease(
          Effect.gen(function* () {
            const serializer = {
              notebookType,
              serializer: impl,
              options: options ?? undefined,
            };
            yield* Ref.update(serializers, HashSet.add(serializer));
            return serializer;
          }),
          (serializer) => Ref.update(serializers, HashSet.remove(serializer)),
        );
      },
      notebookDocumentOpened: Stream.fromPubSub(documentOpened),
      notebookDocumentChanges: Stream.fromPubSub(documentChanges),
      notebookDocumentClosed: Stream.fromPubSub(documentClosed),
      // Mirrors the real implementation's guarantee: the subscription is
      // live and the snapshot captured before the effect completes, so an
      // open or close published afterwards cannot be lost.
      subscribeNotebookLifecycle: Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(documentLifecycle);
        const { documents } = yield* SubscriptionRef.get(notebooks);
        return Stream.concat(
          Stream.fromIterable(
            Array.from(documents, (document) => ({
              type: "opened" as const,
              document,
            })),
          ),
          Stream.fromSubscription(subscription),
        );
      }),
      fileRenames: Stream.never,
      fileDeletes: Stream.never,
      textDocumentChanges: Stream.never,
      createFileSystemWatcher() {
        return Stream.never;
      },
      applyEdit(edit) {
        return Ref.update(workspaceEdits, (current) => [...current, edit]).pipe(
          Effect.as(true),
        );
      },
      openNotebookDocument(uri: vscode.Uri) {
        return Effect.succeed(new NotebookDocument("marimo-notebook", uri));
      },
      openUntitledNotebookDocument(
        notebookType: string,
        content?: vscode.NotebookData,
      ) {
        return Effect.succeed(
          new NotebookDocument(
            notebookType,
            Uri.file("/mocks/foo.py"),
            content,
          ),
        );
      },
      openUntitledTextDocument(options: {
        content?: string;
        language?: string;
      }) {
        const version = 1;
        return Effect.succeed(
          new TextDocument(
            Uri.file("/mocks/foo.txt"),
            options.language ?? "plaintext",
            version,
            options.content ?? "",
          ),
        );
      },
      ...behavior.workspace,
    },
    env: {
      appName: "Marimo Test",
      appRoot: "/mocks",
      appHost: "desktop",
      machineId: "mock-machine-id",
      createTelemetryLogger(sender, loggerOptions) {
        const withCommon = (data: Record<string, unknown> = {}) => ({
          ...data,
          ...loggerOptions?.additionalCommonProperties,
        });
        return acquireDisposable(() => ({
          isUsageEnabled: true,
          isErrorsEnabled: true,
          onDidChangeEnableStates: () => ({ dispose() {} }),
          logUsage(eventName, data) {
            sender.sendEventData(eventName, withCommon(data));
          },
          logError(eventNameOrError, data) {
            if (typeof eventNameOrError === "string") {
              sender.sendEventData(eventNameOrError, withCommon(data));
            } else {
              sender.sendErrorData(eventNameOrError, withCommon(data));
            }
          },
          dispose() {},
        }));
      },
      openExternal(uri) {
        return Ref.update(openedExternalUris, (current) => [
          ...current,
          uri.toString(true),
        ]).pipe(Effect.as(true));
      },
      ...behavior.env,
    },
    debug: {
      registerDebugConfigurationProvider() {
        return Effect.acquireRelease(Effect.void, () => Effect.void);
      },
      registerDebugAdapterDescriptorFactory() {
        return Effect.acquireRelease(Effect.void, () => Effect.void);
      },
      startDebugging() {
        return Effect.succeed(true);
      },
      stopDebugging(_sessionId?: string) {
        return Effect.void;
      },
      onDidTerminateDebugSession() {
        return Effect.acquireRelease(Effect.void, () => Effect.void);
      },
    },
    notebooks: {
      createNotebookController(id, notebookType, label) {
        return Effect.acquireRelease(
          Effect.gen(function* () {
            const emitter = new EventEmitter();
            const controller: vscode.NotebookController = {
              id,
              notebookType,
              label,
              onDidChangeSelectedNotebooks: emitter.event,
              dispose: () => emitter.dispose(),
              createNotebookCellExecution() {
                return {
                  start() {},
                  end() {},
                  async appendOutput() {},
                  async clearOutput() {},
                  async appendOutputItems() {},
                  executionOrder: undefined,
                  token: {
                    isCancellationRequested: false,
                    onCancellationRequested() {
                      return { dispose: () => {} };
                    },
                  },
                  async replaceOutput() {},
                  async replaceOutputItems() {},
                  get cell(): vscode.NotebookCell {
                    throw new Error(
                      "CellExecution.cell not implemented in TestVsCode.",
                    );
                  },
                };
              },
              executeHandler() {},
              updateNotebookAffinity(
                notebook: vscode.NotebookDocument,
                affinity: vscode.NotebookControllerAffinity,
              ) {
                Effect.runSyncWith(context)(
                  SubscriptionRef.update(affinityUpdates, (updates) => [
                    ...updates,
                    {
                      controllerId: id,
                      notebookUri: notebook.uri.toString(),
                      affinity,
                    },
                  ]),
                );
              },
            };
            controllerSelectionEmitters.set(id, emitter);
            yield* SubscriptionRef.update(controllers, HashSet.add(controller));
            return controller;
          }),
          (controller) =>
            Effect.gen(function* () {
              controllerSelectionEmitters.delete(controller.id);
              yield* Effect.sync(() => controller.dispose());
              yield* SubscriptionRef.update(
                controllers,
                HashSet.remove(controller),
              );
            }),
        );
      },
      createRendererMessaging() {
        return Effect.succeed({
          postMessage(message: RendererReceiveMessage) {
            Effect.runSyncWith(context)(Queue.offer(rendererReplies, message));
            return Promise.resolve(true);
          },
          onDidReceiveMessage(listener) {
            const disposable = rendererMessages.event(listener);
            Effect.runSyncWith(context)(
              Deferred.succeed(rendererMessagingReady, undefined),
            );
            return disposable;
          },
        });
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
          const registration = {
            notebookType,
            provideCellStatusBarItems: (cell: vscode.NotebookCell) =>
              impl.provideCellStatusBarItems(cell),
          };
          yield* Ref.update(statusBarProviders, (providers) => [
            ...providers,
            registration,
          ]);
          yield* Effect.addFinalizer(() =>
            Ref.update(statusBarProviders, (providers) =>
              providers.filter((p) => p !== registration),
            ),
          );
        });
      },
    },
    auth: {
      getSession() {
        return Effect.succeed(Option.none());
      },
    },
    NotebookData,
    NotebookCellData,
    NotebookCellKind: {
      Markup: 1,
      Code: 2,
    },
    NotebookCellOutput,
    NotebookCellOutputItem,
    NotebookEdit,
    NotebookRange,
    NotebookCellStatusBarItem,
    NotebookCellStatusBarAlignment: {
      Left: 1,
      Right: 2,
    },
    NotebookControllerAffinity: {
      Default: 1,
      Preferred: 2,
    },
    NotebookEditorRevealType: {
      Default: 0,
      InCenter: 1,
      InCenterIfOutsideViewport: 2,
      AtTop: 3,
    },
    WorkspaceEdit,
    EventEmitter,
    // oxlint-disable-next-line no-extraneous-class
    DebugAdapterInlineImplementation: class {},
    ProgressLocation: {
      SourceControl: 1,
      Window: 10,
      Notification: 15,
    },
    ThemeIcon,
    TreeItem,
    TreeItemCollapsibleState: {
      None: 0,
      Collapsed: 1,
      Expanded: 2,
    },
    ThemeColor,
    StatusBarAlignment: {
      Left: 1,
      Right: 2,
    },
    Uri,
    RelativePattern,
    MarkdownString,
    CompletionItem,
    CompletionList,
    Position,
    Range,
    Location,
    Hover,
    TextEdit,
    SignatureHelp,
    InlayHint,
    InlayHintLabelPart,
    SnippetString,
    CodeAction,
    CodeActionKind,
    SignatureInformation,
    ParameterInformation,
    CodeLens,
    DocumentHighlight,
    DocumentSymbol,
    FoldingRange,
    SelectionRange,
    SemanticTokensLegend,
    SemanticTokens,
    CompletionTriggerKind: {
      Invoke: 0,
      TriggerCharacter: 1,
      TriggerForIncompleteCompletions: 2,
    },
    CompletionItemKind: {
      Text: 0,
      Method: 1,
      Function: 2,
      Constructor: 3,
      Field: 4,
      Variable: 5,
      Class: 6,
      Interface: 7,
      Module: 8,
      Property: 9,
      Unit: 10,
      Value: 11,
      Enum: 12,
      Keyword: 13,
      Snippet: 14,
      Color: 15,
      File: 16,
      Reference: 17,
      Folder: 18,
      EnumMember: 19,
      Constant: 20,
      Struct: 21,
      Event: 22,
      Operator: 23,
      TypeParameter: 24,
      User: 25,
      Issue: 26,
    },
    version: options.version ?? "1.86.0",
    extensions: {
      getExtension: <T = unknown>(extensionId: string) =>
        options.installedExtensions?.includes(extensionId)
          ? // Only identity matters to callers here; the rest of the
            // Extension surface is not exercised by tests.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            Option.some({ id: extensionId } as vscode.Extension<T>)
          : Option.none<vscode.Extension<T>>(),
    },
    lm: {
      registerTool: () => Effect.succeed({ dispose: () => {} }),
    },
    LanguageModelToolResult,
    LanguageModelTextPart,
    languages: {
      registerCodeLensProvider: () => Effect.void,
      createDiagnosticCollection: (name: string) =>
        new DiagnosticCollection(name),
      registerHoverProvider: () => Effect.void,
      registerDefinitionProvider: () => Effect.void,
      registerDeclarationProvider: () => Effect.void,
      registerTypeDefinitionProvider: () => Effect.void,
      registerReferenceProvider: () => Effect.void,
      registerDocumentHighlightProvider: () => Effect.void,
      registerDocumentSymbolProvider: () => Effect.void,
      registerFoldingRangeProvider: () => Effect.void,
      registerSelectionRangeProvider: () => Effect.void,
      registerDocumentFormattingEditProvider: () => Effect.void,
      registerDocumentRangeFormattingEditProvider: () => Effect.void,
      registerSignatureHelpProvider: () => Effect.void,
      registerInlayHintsProvider: () => Effect.void,
      registerCompletionItemProvider: () => Effect.void,
      registerCodeActionsProvider: () => Effect.void,
      registerRenameProvider: () => Effect.void,
      registerDocumentSemanticTokensProvider: () => Effect.void,
      registerDocumentRangeSemanticTokensProvider: () => Effect.void,
    },
    Diagnostic,
    DiagnosticSeverity: {
      Error: 0,
      Warning: 1,
      Information: 2,
      Hint: 3,
    },
    CodeActionTriggerKind: {
      Invoke: 1,
      Automatic: 2,
    },
    // helper
    utils: {
      parseUri(value: string) {
        return Result.try({
          try: () => Uri.parse(value, /* strict */ true),
          catch: (cause) => new VsCode.ParseUriError({ cause }),
        });
      },
    },
  });

  const setActiveNotebookEditor: Interface["setActiveNotebookEditor"] = (
    editor,
  ) =>
    SubscriptionRef.update(notebooks, (state) => ({
      ...state,
      active: editor,
      visible:
        Option.isSome(editor) && !state.visible.includes(editor.value)
          ? [...state.visible, editor.value]
          : state.visible,
    }));

  const selectNotebookController: Interface["selectNotebookController"] = (
    controllerId,
    notebook,
    selected,
  ) =>
    Effect.sync(() => {
      const emitter = controllerSelectionEmitters.get(controllerId);
      if (emitter === undefined) {
        throw new Error(
          `Notebook controller is not registered: ${controllerId}`,
        );
      }
      emitter.fire({ notebook, selected });
    });

  const rendererMessaging: Interface["rendererMessaging"] = {
    ready: Deferred.await(rendererMessagingReady),
    send: (editor, message) =>
      Effect.sync(() => rendererMessages.fire({ editor, message })),
    receive: Queue.take(rendererReplies),
  };

  const setActiveTextEditor: Interface["setActiveTextEditor"] = (editor) =>
    SubscriptionRef.update(textEditors, (state) => ({
      active: editor,
      visible:
        Option.isSome(editor) && !state.visible.includes(editor.value)
          ? [...state.visible, editor.value]
          : state.visible,
    }));

  const addNotebookDocument = (doc: vscode.NotebookDocument) =>
    SubscriptionRef.update(notebooks, (state) => ({
      ...state,
      // A URI has one current opening. Preserve object identity so a late
      // close for an older opening cannot remove its replacement.
      documents: [
        ...state.documents.filter(
          (current) => current.uri.toString() !== doc.uri.toString(),
        ),
        doc,
      ],
    }));
  const removeNotebookDocument = (doc: vscode.NotebookDocument) =>
    SubscriptionRef.update(notebooks, (state) => ({
      documents: state.documents.filter((current) => current !== doc),
      active: Option.filter(state.active, (editor) => editor.notebook !== doc),
      visible: state.visible.filter((editor) => editor.notebook !== doc),
    }));
  const notebookChange: Interface["notebookChange"] = (event) =>
    PubSub.publish(documentChanges, event);
  const openNotebook: Interface["openNotebook"] = (doc) =>
    addNotebookDocument(doc).pipe(
      Effect.andThen(PubSub.publish(documentOpened, doc)),
      Effect.andThen(
        PubSub.publish(documentLifecycle, {
          type: "opened" as const,
          document: doc,
        }),
      ),
      Effect.asVoid,
      Effect.uninterruptible,
    );
  const closeNotebook: Interface["closeNotebook"] = (doc) =>
    Effect.sync(() => closeNotebookDocument(doc)).pipe(
      Effect.andThen(removeNotebookDocument(doc)),
      Effect.andThen(PubSub.publish(documentClosed, doc)),
      Effect.andThen(
        PubSub.publish(documentLifecycle, {
          type: "closed" as const,
          document: doc,
        }),
      ),
      Effect.asVoid,
      Effect.uninterruptible,
    );

  const snapshot = Effect.gen(function* () {
    const currentViews = yield* Ref.get(views);
    const currentCommands = yield* Ref.get(commands);
    const currentSerializers = yield* Ref.get(serializers);
    const currentControllers = yield* SubscriptionRef.get(controllers);
    const currentExecutions = yield* Ref.get(executions);
    const currentAffinityUpdates = yield* SubscriptionRef.get(affinityUpdates);
    const currentOpenedExternalUris = yield* Ref.get(openedExternalUris);
    const currentWorkspaceEdits = yield* Ref.get(workspaceEdits);
    const currentQuickPicks = yield* Ref.get(quickPicks);
    const currentInformationMessages = yield* Ref.get(informationMessages);
    const currentWarningMessages = yield* Ref.get(warningMessages);
    const currentErrorMessages = yield* Ref.get(errorMessages);
    const {
      documents: currentDocuments,
      active: currentActiveEditor,
      visible: currentVisibleEditors,
    } = yield* SubscriptionRef.get(notebooks);

    return {
      inputs: (yield* SubscriptionRef.get(inputs)).map((request) => ({
        ...request,
      })),
      views: Array.from(currentViews).toSorted(),
      commands: Array.from(currentCommands).toSorted(),
      serializers: Array.from(
        currentSerializers,
        (entry) => entry.notebookType,
      ).toSorted(),
      controllers: Array.from(
        currentControllers,
        (entry) => entry.id,
      ).toSorted(),
      executions: currentExecutions.map((entry) => ({
        command: entry.command,
        args: [...entry.args],
      })),
      affinityUpdates: currentAffinityUpdates.map((entry) => ({ ...entry })),
      openedExternalUris: [...currentOpenedExternalUris],
      workspaceEdits: [...currentWorkspaceEdits],
      openNotebookUris: Array.from(currentDocuments, (document) =>
        document.uri.toString(),
      ).toSorted(),
      activeNotebookUri: Option.map(currentActiveEditor, (editor) =>
        editor.notebook.uri.toString(),
      ),
      visibleNotebookUris: currentVisibleEditors
        .map((editor) => editor.notebook.uri.toString())
        .toSorted(),
      quickPicks: currentQuickPicks.map((request) => ({
        ...request,
        items: request.items.map((item) => ({ ...item })),
      })),
      informationMessages: [...currentInformationMessages],
      warningMessages: [...currentWarningMessages],
      errorMessages: [...currentErrorMessages],
    } satisfies Snapshot;
  });

  const testService = Service.of({
    inputChanges: SubscriptionRef.changes(inputs),
    respondToInput: (value) => Queue.offer(inputResponses, value),
    snapshot,
    controllers: Effect.map(SubscriptionRef.get(controllers), (items) =>
      Array.from(items),
    ),
    controllerChanges: SubscriptionRef.changes(controllers).pipe(
      Stream.map((items) => Array.from(items)),
    ),
    affinityChanges: SubscriptionRef.changes(affinityUpdates),
    serializers: Effect.map(Ref.get(serializers), (items) => Array.from(items)),
    statusBarProviders: Effect.map(Ref.get(statusBarProviders), (providers) => [
      ...providers,
    ]),
    openNotebook,
    closeNotebook,
    notebookChange,
    setActiveNotebookEditor,
    setActiveTextEditor,
    selectQuickPick: (label) =>
      Queue.offer(quickPickResponses, QuickPickResponse.Single({ label })),
    selectQuickPickMany: (labels) =>
      Queue.offer(
        quickPickResponses,
        QuickPickResponse.Many({ labels: [...labels] }),
      ),
    selectInformationMessage: (item) =>
      Queue.offer(informationMessageResponses, item),
    selectErrorMessage: (item) => Queue.offer(errorMessageResponses, item),
    configurationChange: (event) =>
      PubSub.publish(configurationChanges, event).pipe(Effect.asVoid),
    awaitExecutions: (predicate) =>
      SubscriptionRef.changes(executionRevision).pipe(
        Stream.mapEffect(() => Ref.get(executions)),
        Stream.filter(predicate),
        Stream.runHead,
        Effect.asVoid,
      ),
    awaitInformationMessages: (count) =>
      SubscriptionRef.changes(informationMessageRevision).pipe(
        Stream.mapEffect(() => Ref.get(informationMessages)),
        Stream.filter((messages) => messages.length >= count),
        Stream.runHead,
        Effect.asVoid,
      ),
    selectNotebookController,
    rendererMessaging,
  });

  return Layer.merge(layer, Layer.succeed(Service, testService));
});

export const layerWith = (options: Options, behavior: Behavior = {}) =>
  Layer.unwrap(makeModel(options, behavior));
export const layer = layerWith({});
