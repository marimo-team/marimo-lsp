import { Effect, Layer, Option, Stream } from "effect";

import openSession from "../../commands/openSession.ts";
import restartSession from "../../commands/restartSession.ts";
import shutdownAllSessions from "../../commands/shutdownAllSessions.ts";
import shutdownSession from "../../commands/shutdownSession.ts";
import { VsCode } from "../../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../../schemas/MarimoNotebookDocument.ts";
import { type TreeItem, TreeView } from "../TreeView.ts";
import { type SessionViewItem, SessionsService } from "./SessionsService.ts";

/** Native VS Code tree view for live marimo kernel sessions. */
export const SessionsViewLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const treeView = yield* TreeView;
    const sessions = yield* SessionsService;
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
            command: code.commands.bind(
              openSession.command,
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

    yield* code.commands.register(openSession);
    yield* code.commands.register(restartSession);
    yield* code.commands.register(shutdownSession);
    yield* code.commands.register(shutdownAllSessions);
  }),
);
