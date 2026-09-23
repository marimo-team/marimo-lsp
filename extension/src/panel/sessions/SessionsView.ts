import { Effect, Layer, Option, Stream } from "effect";

import openSession from "../../commands/openSession.ts";
import restartSession from "../../commands/restartSession.ts";
import shutdownAllSessions from "../../commands/shutdownAllSessions.ts";
import shutdownSession from "../../commands/shutdownSession.ts";
import * as VsCode from "../../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../../schemas/MarimoNotebookDocument.ts";
import * as TreeView from "../TreeView.ts";
import * as LiveSessions from "./LiveSessions.ts";

/** Native VS Code tree view for live marimo kernel sessions. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode.Service;
    const treeView = yield* TreeView.Service;
    const sessions = yield* LiveSessions.Service;
    const provider = yield* treeView.createTreeDataProvider({
      viewId: "marimo-explorer-sessions",
      showCollapseAll: false,
      getChildren: Effect.fn("SessionsView.getChildren")(
        (element?: LiveSessions.Item) =>
          element
            ? Effect.succeed([])
            : Effect.map(sessions.get, (items) => [...items]),
      ),
      getTreeItem: Effect.fn("SessionsView.getTreeItem")(
        (session: LiveSessions.Item) =>
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
            const item: TreeView.TreeItem = {
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
      ),
    });

    yield* code.commands.setContext("marimo.hasLiveSessions", false);
    const render = Effect.fn("SessionsView.render")(function* (
      live: ReadonlyArray<LiveSessions.Item>,
    ) {
      yield* provider.refresh();
      yield* code.commands.setContext(
        "marimo.hasLiveSessions",
        live.length > 0,
      );
    });
    yield* Effect.forkScoped(sessions.changes.pipe(Stream.runForEach(render)));

    const revealActive = Effect.gen(function* () {
      const editor = yield* code.window.getActiveNotebookEditor;
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
    }).pipe(Effect.withSpan("SessionsView.revealActive"), Effect.ignore);

    yield* Effect.forkScoped(revealActive);
    yield* Effect.forkScoped(
      code.window.activeNotebookEditorChanges.pipe(
        Stream.runForEach(() => revealActive),
      ),
    );
    yield* Effect.forkScoped(
      sessions.changes.pipe(Stream.runForEach(() => revealActive)),
    );

    yield* code.commands.register(openSession);
    yield* code.commands.register(restartSession);
    yield* code.commands.register(shutdownSession);
    yield* code.commands.register(shutdownAllSessions);
  }).pipe(Effect.withSpan("SessionsView.layer")),
);
