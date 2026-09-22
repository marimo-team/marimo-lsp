import {
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Queue,
  Scope,
  Stream,
} from "effect";
// oxlint-disable-next-line marimo/vscode-type-only
import * as vscode from "vscode";

import { acquireDisposable } from "../lib/acquireDisposable.ts";

export class FileSystemError extends Data.TaggedError(
  "Workspace.FileSystemError",
)<{
  readonly cause: unknown;
}> {}

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
 * Subscribe before taking the initial snapshot so no event can be missed. A
 * document may be observed twice (snapshot and event) but never zero times;
 * consumers must treat a re-observed open as idempotent.
 */
export const makeNotebookLifecycle = Effect.fn(
  "Workspace.makeNotebookLifecycle",
)(function* (source: NotebookLifecycleSource) {
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
});

export interface FileSystem {
  readonly createDirectory: (
    uri: vscode.Uri,
  ) => Effect.Effect<void, FileSystemError>;
  readonly readFile: (
    uri: vscode.Uri,
  ) => Effect.Effect<Uint8Array, FileSystemError>;
  readonly writeFile: (
    uri: vscode.Uri,
    contents: Uint8Array,
  ) => Effect.Effect<void, FileSystemError>;
}

export interface Interface {
  readonly fs: FileSystem;
  readonly getNotebookDocuments: Effect.Effect<
    readonly vscode.NotebookDocument[]
  >;
  readonly getTextDocuments: Effect.Effect<readonly vscode.TextDocument[]>;
  readonly getConfiguration: (
    section: string,
    scope?: vscode.ConfigurationScope,
  ) => Effect.Effect<vscode.WorkspaceConfiguration>;
  readonly getWorkspaceFolders: Effect.Effect<
    Option.Option<readonly vscode.WorkspaceFolder[]>
  >;
  readonly isTrusted: () => boolean;
  readonly registerNotebookSerializer: (
    notebookType: string,
    impl: vscode.NotebookSerializer,
    options?: vscode.NotebookDocumentContentOptions,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly notebookDocumentChanges: Stream.Stream<vscode.NotebookDocumentChangeEvent>;
  readonly notebookDocumentOpened: Stream.Stream<vscode.NotebookDocument>;
  readonly subscribeNotebookLifecycle: Effect.Effect<
    Stream.Stream<NotebookLifecycleEvent>,
    never,
    Scope.Scope
  >;
  readonly textDocumentChanges: Stream.Stream<vscode.TextDocumentChangeEvent>;
  readonly notebookDocumentClosed: Stream.Stream<vscode.NotebookDocument>;
  readonly fileRenames: Stream.Stream<vscode.FileRenameEvent>;
  readonly fileDeletes: Stream.Stream<vscode.FileDeleteEvent>;
  readonly configurationChanges: Stream.Stream<vscode.ConfigurationChangeEvent>;
  readonly applyEdit: (edit: vscode.WorkspaceEdit) => Effect.Effect<boolean>;
  readonly openNotebookDocument: (
    uri: vscode.Uri,
  ) => Effect.Effect<vscode.NotebookDocument>;
  readonly openUntitledNotebookDocument: (
    notebookType: string,
    content?: vscode.NotebookData,
  ) => Effect.Effect<vscode.NotebookDocument>;
  readonly openUntitledTextDocument: (options: {
    readonly content?: string;
    readonly language?: string;
  }) => Effect.Effect<vscode.TextDocument>;
  readonly createFileSystemWatcher: (
    globPattern: vscode.GlobPattern,
  ) => Stream.Stream<{ readonly uri: vscode.Uri; readonly type: 1 | 2 | 3 }>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/Workspace",
) {}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const api = vscode.workspace;

    const createDirectory = Effect.fn("Workspace.fs.createDirectory")(
      function* (uri: vscode.Uri) {
        yield* Effect.tryPromise({
          try: () => api.fs.createDirectory(uri),
          catch: (cause) => new FileSystemError({ cause }),
        });
      },
    );

    const readFile = Effect.fn("Workspace.fs.readFile")(function* (
      uri: vscode.Uri,
    ) {
      return yield* Effect.tryPromise({
        try: () => api.fs.readFile(uri),
        catch: (cause) => new FileSystemError({ cause }),
      });
    });

    const writeFile = Effect.fn("Workspace.fs.writeFile")(function* (
      uri: vscode.Uri,
      contents: Uint8Array,
    ) {
      yield* Effect.tryPromise({
        try: () => api.fs.writeFile(uri, contents),
        catch: (cause) => new FileSystemError({ cause }),
      });
    });

    const getConfiguration = Effect.fn("Workspace.getConfiguration")(function* (
      section: string,
      scope?: vscode.ConfigurationScope,
    ) {
      return yield* Effect.sync(() => api.getConfiguration(section, scope));
    });

    const registerNotebookSerializer = Effect.fn(
      "Workspace.registerNotebookSerializer",
    )(function* (
      notebookType: string,
      impl: vscode.NotebookSerializer,
      options?: vscode.NotebookDocumentContentOptions,
    ) {
      yield* acquireDisposable(() =>
        api.registerNotebookSerializer(notebookType, impl, options),
      );
    });

    const applyEdit = Effect.fn("Workspace.applyEdit")(function* (
      edit: vscode.WorkspaceEdit,
    ) {
      return yield* Effect.promise(() => api.applyEdit(edit));
    });

    const openNotebookDocument = Effect.fn("Workspace.openNotebookDocument")(
      function* (uri: vscode.Uri) {
        return yield* Effect.promise(() => api.openNotebookDocument(uri));
      },
    );

    const openUntitledNotebookDocument = Effect.fn(
      "Workspace.openUntitledNotebookDocument",
    )(function* (notebookType: string, content?: vscode.NotebookData) {
      return yield* Effect.promise(() =>
        api.openNotebookDocument(notebookType, content),
      );
    });

    const openUntitledTextDocument = Effect.fn(
      "Workspace.openUntitledTextDocument",
    )(function* (options: {
      readonly content?: string;
      readonly language?: string;
    }) {
      return yield* Effect.promise(() => api.openTextDocument(options));
    });

    const createFileSystemWatcher = (globPattern: vscode.GlobPattern) =>
      Stream.callback<{ uri: vscode.Uri; type: 1 | 2 | 3 }>((queue) =>
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

    return Service.of({
      fs: {
        createDirectory,
        readFile,
        writeFile,
      },
      getNotebookDocuments: Effect.sync(() => api.notebookDocuments),
      getTextDocuments: Effect.sync(() => api.textDocuments),
      getConfiguration,
      getWorkspaceFolders: Effect.sync(() =>
        Option.fromNullishOr(api.workspaceFolders),
      ),
      isTrusted() {
        return api.isTrusted;
      },
      registerNotebookSerializer,
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
      applyEdit,
      openNotebookDocument,
      openUntitledNotebookDocument,
      openUntitledTextDocument,
      createFileSystemWatcher,
    });
  }),
);
