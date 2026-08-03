import { Effect, Layer, Option, Stream } from "effect";

import { toVscodeCommand } from "../../commands.ts";
import { MarimoCommands } from "../../commands/MarimoCommands.ts";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import { CellExecutions } from "../../kernel/CellExecutions.ts";
import { showErrorAndPromptLogs } from "../../lib/showErrorAndPromptLogs.ts";
import { NotebookEditorRegistry } from "../../notebook/NotebookEditorRegistry.ts";
import { VsCode } from "../../platform/VsCode.ts";
import {
  MarimoNotebookDocument,
  type NotebookId,
} from "../../schemas/MarimoNotebookDocument.ts";
import { type TreeItem, TreeView } from "../TreeView.ts";
import { type SessionViewItem, SessionsService } from "./SessionsService.ts";

export const openSessionNotebook = Effect.fn("SessionsView.openNotebook")(
  function* (notebookUri: NotebookId) {
    const code = yield* VsCode;
    const openNotebooks = yield* code.workspace.getNotebookDocuments();
    const existing = openNotebooks.find(
      (document) =>
        document.notebookType === NOTEBOOK_TYPE &&
        document.uri.toString(true) === notebookUri,
    );

    if (existing) {
      yield* code.window.showNotebookDocument(existing);
      return;
    }

    const uri = code.Uri.parse(notebookUri);
    yield* code.commands.executeVSCode("vscode.openWith", uri, NOTEBOOK_TYPE);
  },
);

/** Native VS Code tree view for live marimo kernel sessions. */
export const SessionsViewLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const treeView = yield* TreeView;
    const sessions = yield* SessionsService;
    const executions = yield* CellExecutions;
    const editors = yield* NotebookEditorRegistry;

    const endExecutions = Effect.fn("SessionsView.endExecutions")(function* (
      notebookUri: NotebookId,
    ) {
      const editor = yield* editors.getLastNotebookEditor(notebookUri);
      if (Option.isSome(editor)) {
        yield* executions.handleInterrupt(editor.value);
      }
    });

    const provider = yield* treeView.createTreeDataProvider({
      viewId: "marimo-explorer-sessions",
      showCollapseAll: false,
      getChildren: (element?: SessionViewItem) =>
        element
          ? Effect.succeed([])
          : Effect.map(sessions.get(), (items) => [...items]),
      getTreeItem: (session: SessionViewItem) =>
        Effect.sync(() => {
          const uri = code.Uri.parse(session.notebookUri);
          const label =
            session.filename ?? uri.path.split("/").at(-1) ?? "Notebook";
          const state =
            session.status === "restarting"
              ? "Restarting"
              : session.status === "running"
                ? "Running"
                : "Idle";
          const attachment = session.attached ? "open" : "background";
          const item: TreeItem = {
            label,
            tooltip: `${uri.fsPath}\n${state} · ${attachment}\n${session.executable}`,
            themeIcon:
              session.status === "restarting"
                ? "sync~spin"
                : session.status === "running"
                  ? "loading~spin"
                  : "circle-outline",
            contextValue: "marimoSession",
            command: toVscodeCommand(
              MarimoCommands.openSession,
              "Open Notebook",
              session,
            ),
            collapsibleState: "None",
            resourceUri: session.notebookUri,
          };
          return item;
        }),
    });

    yield* code.commands.setContext("marimo.hasLiveSessions", false);
    yield* Effect.forkScoped(
      sessions.changes().pipe(
        Stream.runForEach(
          Effect.fn(function* (live) {
            yield* provider.refresh();
            yield* code.commands.setContext(
              "marimo.hasLiveSessions",
              live.length > 0,
            );
          }),
        ),
      ),
    );

    const revealActiveSession = Effect.fn("SessionsView.revealActiveSession")(
      function* () {
        const editor = yield* code.window.getActiveNotebookEditor();
        const notebook = Option.flatMap(editor, (active) =>
          MarimoNotebookDocument.tryFrom(active.notebook),
        );
        if (Option.isNone(notebook)) return;
        const session = yield* sessions.find(notebook.value.id);
        if (Option.isSome(session)) {
          yield* provider.reveal(session.value, {
            select: true,
            focus: false,
            expand: false,
          });
        }
      },
    );

    yield* Effect.forkScoped(revealActiveSession().pipe(Effect.ignore));
    yield* Effect.forkScoped(
      code.window
        .activeNotebookEditorChanges()
        .pipe(
          Stream.runForEach(() => revealActiveSession().pipe(Effect.ignore)),
        ),
    );
    yield* Effect.forkScoped(
      sessions
        .changes()
        .pipe(
          Stream.runForEach(() => revealActiveSession().pipe(Effect.ignore)),
        ),
    );

    yield* code.commands.register(
      MarimoCommands.openSession,
      Effect.fn("SessionsView.open")(function* ({ notebookUri }) {
        yield* openSessionNotebook(notebookUri);
      }),
    );

    yield* code.commands.register(
      MarimoCommands.restartSession,
      Effect.fn("SessionsView.restart")(function* ({ notebookUri }) {
        yield* sessions.restart(notebookUri).pipe(
          Effect.tap(() => endExecutions(notebookUri)),
          Effect.catchAllCause(
            Effect.fn(function* (cause) {
              yield* Effect.logError("Failed to restart kernel").pipe(
                Effect.annotateLogs({ cause, notebookUri }),
              );
              yield* showErrorAndPromptLogs("Failed to restart kernel.");
            }),
          ),
        );
      }),
    );

    yield* code.commands.register(
      MarimoCommands.shutdownSession,
      Effect.fn("SessionsView.shutdown")(function* ({ notebookUri }) {
        const session = yield* sessions.find(notebookUri);
        if (Option.isNone(session)) return;

        yield* sessions.shutdown(notebookUri);
        yield* endExecutions(notebookUri);
        const choice = yield* code.window.showInformationMessage(
          `Shut down kernel for ${session.value.filename ?? "notebook"}.`,
          { items: ["Restart"] },
        );
        if (!Option.contains(choice, "Restart")) return;

        yield* openSessionNotebook(notebookUri);
        yield* sessions.restore(
          notebookUri,
          session.value.executable,
          session.value.workingDirectory,
        );
      }),
    );

    yield* code.commands.register(
      MarimoCommands.shutdownAllSessions,
      Effect.fn("SessionsView.shutdownAll")(function* () {
        const live = yield* sessions.get();
        if (live.length === 0) return;
        if (live.length > 1) {
          const choice = yield* code.window.showWarningMessage(
            `Shut down all ${live.length} live kernels?`,
            { modal: true, items: ["Shut Down All"] },
          );
          if (!Option.contains(choice, "Shut Down All")) return;
        }
        yield* sessions.shutdownAll();
        yield* Effect.forEach(
          live,
          (session) => endExecutions(session.notebookUri),
          { discard: true },
        );
      }),
    );
  }),
);
