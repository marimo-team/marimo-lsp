import {
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
// oxlint-disable-next-line marimo/vscode-type-only
import * as vscode from "vscode";

import { acquireDisposable } from "../lib/acquireDisposable.ts";
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

export interface Interface {
  readonly createTerminal: (
    options: vscode.TerminalOptions,
  ) => Effect.Effect<
    Pick<vscode.Terminal, "show" | "sendText">,
    never,
    Scope.Scope
  >;
  readonly showSaveDialog: (
    options?: vscode.SaveDialogOptions,
  ) => Effect.Effect<Option.Option<vscode.Uri>>;
  readonly showInputBox: (
    options?: vscode.InputBoxOptions,
  ) => Effect.Effect<Option.Option<string>>;
  readonly showInformationMessage: <T extends string>(
    message: string,
    options?: vscode.MessageOptions & { items?: readonly T[] },
  ) => Effect.Effect<Option.Option<T>>;
  readonly showWarningMessage: <T extends string>(
    message: string,
    options?: vscode.MessageOptions & { items?: readonly T[] },
  ) => Effect.Effect<Option.Option<T>>;
  readonly showErrorMessage: <T extends string>(
    message: string,
    options?: vscode.MessageOptions & { items?: readonly T[] },
  ) => Effect.Effect<Option.Option<T>>;
  readonly showQuickPick: (
    items: readonly string[],
    options?: Omit<vscode.QuickPickOptions, "canPickMany">,
  ) => Effect.Effect<Option.Option<string>>;
  readonly showQuickPickItems: <T extends vscode.QuickPickItem>(
    items: readonly T[],
    options?: Omit<vscode.QuickPickOptions, "canPickMany">,
  ) => Effect.Effect<Option.Option<T>>;
  readonly showQuickPickItemsMany: <T extends vscode.QuickPickItem>(
    items: readonly T[],
    options?: Omit<vscode.QuickPickOptions, "canPickMany">,
  ) => Effect.Effect<Option.Option<readonly T[]>>;
  readonly createOutputChannel: (
    name: string,
  ) => Effect.Effect<vscode.OutputChannel, never, Scope.Scope>;
  readonly createLogOutputChannel: (
    name: string,
  ) => Effect.Effect<vscode.LogOutputChannel, never, Scope.Scope>;
  readonly getActiveNotebookEditor: Effect.Effect<
    Option.Option<vscode.NotebookEditor>
  >;
  readonly getVisibleNotebookEditors: Effect.Effect<
    readonly vscode.NotebookEditor[]
  >;
  readonly getVisibleTextEditors: Effect.Effect<readonly vscode.TextEditor[]>;
  readonly getActiveTextEditor: Effect.Effect<Option.Option<vscode.TextEditor>>;
  readonly closeTextEditorTab: (
    uri: vscode.Uri,
  ) => Effect.Effect<boolean | void>;
  readonly createTreeView: <T>(
    viewId: string,
    options: vscode.TreeViewOptions<T>,
  ) => Effect.Effect<vscode.TreeView<T>, never, Scope.Scope>;
  readonly createStatusBarItem: (
    id: string,
    alignment: vscode.StatusBarAlignment,
    priority?: number,
  ) => Effect.Effect<vscode.StatusBarItem, never, Scope.Scope>;
  readonly colorThemeChanges: Stream.Stream<"light" | "dark">;
  readonly activeNotebookEditorChanges: Stream.Stream<
    Option.Option<vscode.NotebookEditor>
  >;
  readonly visibleNotebookEditorsChanges: Stream.Stream<
    readonly vscode.NotebookEditor[]
  >;
  readonly visibleTextEditorsChanges: Stream.Stream<
    readonly vscode.TextEditor[]
  >;
  readonly activeTextEditorChanges: Stream.Stream<
    Option.Option<vscode.TextEditor>
  >;
  readonly showNotebookDocument: (
    doc: vscode.NotebookDocument,
    options?: vscode.NotebookDocumentShowOptions,
  ) => Effect.Effect<vscode.NotebookEditor>;
  readonly showTextDocument: (doc: vscode.TextDocument) => Effect.Effect<void>;
  readonly withProgress: <A, E, R>(
    options: {
      readonly location: vscode.ProgressLocation;
      readonly title: string;
      readonly cancellable: boolean;
    },
    fn: (
      progress: vscode.Progress<{ message: string; increment?: number }>,
    ) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/Window",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
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
    yield* acquireDisposable(() =>
      api.onDidChangeActiveColorTheme((theme) => {
        runSync(SubscriptionRef.set(colorThemeRef, resolve(theme.kind)));
      }),
    );

    const createTerminal = Effect.fn("Window.createTerminal")(function* (
      options: vscode.TerminalOptions,
    ) {
      return yield* acquireDisposable(() => api.createTerminal(options));
    });

    const showSaveDialog = Effect.fn("Window.showSaveDialog")(function* (
      options?: vscode.SaveDialogOptions,
    ) {
      const uri = yield* Effect.promise(() => api.showSaveDialog(options));
      return Option.fromNullishOr(uri);
    });

    const showInputBox = Effect.fn("Window.showInputBox")(function* (
      options?: vscode.InputBoxOptions,
    ) {
      const value = yield* Effect.promise((signal) =>
        api.showInputBox(options, tokenFromSignal(signal)),
      );
      return Option.fromNullishOr(value);
    });

    const showInformationMessage = Effect.fn("Window.showInformationMessage")(
      function* <T extends string>(
        message: string,
        options: vscode.MessageOptions & { items?: readonly T[] } = {},
      ) {
        const { items = [], ...rest } = options;
        const selected = yield* Effect.promise(() =>
          api.showInformationMessage(message, rest, ...items),
        );
        return Option.fromNullishOr(selected);
      },
    );

    const showWarningMessage = Effect.fn("Window.showWarningMessage")(
      function* <T extends string>(
        message: string,
        options: vscode.MessageOptions & { items?: readonly T[] } = {},
      ) {
        const { items = [], ...rest } = options;
        const selected = yield* Effect.promise(() =>
          api.showWarningMessage(message, rest, ...items),
        );
        return Option.fromNullishOr(selected);
      },
    );

    const showErrorMessage = Effect.fn("Window.showErrorMessage")(function* <
      T extends string,
    >(
      message: string,
      options: vscode.MessageOptions & { items?: readonly T[] } = {},
    ) {
      const { items = [], ...rest } = options;
      const selected = yield* Effect.promise(() =>
        api.showErrorMessage(message, rest, ...items),
      );
      return Option.fromNullishOr(selected);
    });

    const showQuickPick = Effect.fn("Window.showQuickPick")(function* (
      items: readonly string[],
      options: Omit<vscode.QuickPickOptions, "canPickMany"> = {},
    ) {
      const selected = yield* Effect.promise((signal) =>
        api.showQuickPick(items, options, tokenFromSignal(signal)),
      );
      return Option.fromNullishOr(selected);
    });

    const showQuickPickItems = Effect.fn("Window.showQuickPickItems")(
      function* <T extends vscode.QuickPickItem>(
        items: readonly T[],
        options: Omit<vscode.QuickPickOptions, "canPickMany"> = {},
      ) {
        const selected = yield* Effect.promise((signal) =>
          api.showQuickPick(items, options, tokenFromSignal(signal)),
        );
        return Option.fromNullishOr(selected);
      },
    );

    const showQuickPickItemsMany = Effect.fn("Window.showQuickPickItemsMany")(
      function* <T extends vscode.QuickPickItem>(
        items: readonly T[],
        options: Omit<vscode.QuickPickOptions, "canPickMany"> = {},
      ) {
        const selected = yield* Effect.promise((signal) =>
          api.showQuickPick(
            items,
            { ...options, canPickMany: true },
            tokenFromSignal(signal),
          ),
        );
        return Option.fromNullishOr(selected);
      },
    );

    const createOutputChannel = Effect.fn("Window.createOutputChannel")(
      function* (name: string) {
        return yield* acquireDisposable(() => api.createOutputChannel(name));
      },
    );

    const createLogOutputChannel = Effect.fn("Window.createLogOutputChannel")(
      function* (name: string) {
        return yield* acquireDisposable(() =>
          api.createOutputChannel(name, { log: true }),
        );
      },
    );

    const closeTextEditorTab = Effect.fn("Window.closeTextEditorTab")(
      function* (uri: vscode.Uri) {
        const tab = Option.fromNullishOr(
          api.tabGroups.all
            .flatMap((group) => group.tabs)
            .find(
              (tab) =>
                tab.input instanceof vscode.TabInputText &&
                tab.input.uri.toString() === uri.toString(),
            ),
        );
        if (Option.isNone(tab)) return undefined;
        return yield* Effect.promise(() => api.tabGroups.close(tab.value));
      },
    );

    const createTreeView = Effect.fn("Window.createTreeView")(function* <T>(
      viewId: string,
      options: vscode.TreeViewOptions<T>,
    ) {
      return yield* acquireDisposable(() =>
        api.createTreeView(viewId, options),
      );
    });

    const createStatusBarItem = Effect.fn("Window.createStatusBarItem")(
      function* (
        id: string,
        alignment: vscode.StatusBarAlignment,
        priority?: number,
      ) {
        return yield* acquireDisposable(() =>
          api.createStatusBarItem(id, alignment, priority),
        );
      },
    );

    const showNotebookDocument = Effect.fn("Window.showNotebookDocument")(
      function* (
        doc: vscode.NotebookDocument,
        options?: vscode.NotebookDocumentShowOptions,
      ) {
        return yield* Effect.promise(() =>
          api.showNotebookDocument(doc, options),
        );
      },
    );

    const showTextDocument = Effect.fn("Window.showTextDocument")(function* (
      doc: vscode.TextDocument,
    ) {
      yield* Effect.promise(() => api.showTextDocument(doc));
    });

    const withProgress = Effect.fn("Window.withProgress")(function* <A, E, R>(
      options: {
        readonly location: vscode.ProgressLocation;
        readonly title: string;
        readonly cancellable: boolean;
      },
      fn: (
        progress: vscode.Progress<{ message: string; increment?: number }>,
      ) => Effect.Effect<A, E, R>,
    ) {
      const context = yield* Effect.context<R>();
      const runCallback = Effect.runCallbackWith(context);
      return yield* Effect.callback<A, E>((resume, signal) => {
        void api.withProgress<unknown>(
          options,
          (progress, token) =>
            new Promise<unknown>((resolve) => {
              let cancellation: vscode.Disposable | undefined;
              let completed = false;
              const interrupt = runCallback(fn(progress), {
                signal,
                onExit: (exit) => {
                  completed = true;
                  cancellation?.dispose();
                  resume(exit);
                  resolve(Exit.isSuccess(exit) ? exit.value : undefined);
                },
              });
              cancellation = token.onCancellationRequested(() => interrupt());
              if (completed) cancellation.dispose();
            }),
        );
      });
    });

    return Service.of({
      createTerminal,
      showSaveDialog,
      showInputBox,
      showInformationMessage,
      showWarningMessage,
      showErrorMessage,
      showQuickPick,
      showQuickPickItems,
      showQuickPickItemsMany,
      createOutputChannel,
      createLogOutputChannel,
      getActiveNotebookEditor: Effect.sync(() =>
        Option.fromNullishOr(api.activeNotebookEditor),
      ),
      getVisibleNotebookEditors: Effect.sync(() => api.visibleNotebookEditors),
      getVisibleTextEditors: Effect.sync(() => api.visibleTextEditors),
      getActiveTextEditor: Effect.sync(() =>
        Option.fromNullishOr(api.activeTextEditor),
      ),
      closeTextEditorTab,
      createTreeView,
      createStatusBarItem,
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
      showNotebookDocument,
      showTextDocument,
      withProgress,
    });
  }),
);
