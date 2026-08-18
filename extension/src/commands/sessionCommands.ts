import { Effect, Option } from "effect";

import { NOTEBOOK_TYPE } from "../constants.ts";
import { NotebookRuntime } from "../kernel/NotebookRuntime.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { LiveSessions } from "../panel/sessions/LiveSessions.ts";
import { VsCode } from "../platform/VsCode.ts";
import { type NotebookId } from "../schemas/MarimoNotebookDocument.ts";
import type { SessionCommandTarget } from "./MarimoCommands.ts";

const openSessionNotebook = Effect.fn("command.openSessionNotebook")(function* (
  notebookUri: NotebookId,
) {
  const code = yield* VsCode;
  const openNotebooks = yield* code.workspace.getNotebookDocuments;
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
});

export const openSession = Effect.fn("command.openSession")(function* ({
  notebookUri,
}: SessionCommandTarget) {
  yield* openSessionNotebook(notebookUri);
});

export const restartSession = Effect.fn("command.restartSession")(function* ({
  notebookUri,
}: SessionCommandTarget) {
  const runtime = yield* NotebookRuntime;
  const notebook = yield* runtime.forNotebook(notebookUri);
  yield* notebook.restart.pipe(
    Effect.catchCause(
      Effect.fn(function* (cause) {
        yield* Effect.logError("Failed to restart kernel").pipe(
          Effect.annotateLogs({ cause, notebookUri }),
        );
        yield* showErrorAndPromptLogs("Failed to restart kernel.");
      }),
    ),
  );
});

export const shutdownSession = Effect.fn("command.shutdownSession")(function* ({
  notebookUri,
}: SessionCommandTarget) {
  const code = yield* VsCode;
  const sessions = yield* LiveSessions;
  const runtime = yield* NotebookRuntime;
  const session = yield* sessions.find(notebookUri);
  if (Option.isNone(session)) return;

  const notebook = yield* runtime.forNotebook(notebookUri);
  yield* notebook.close;
  const choice = yield* code.window.showInformationMessage(
    `Shut down kernel for ${session.value.filename ?? "notebook"}.`,
    { items: ["Restart"] },
  );
  if (!Option.contains(choice, "Restart")) return;

  yield* openSessionNotebook(notebookUri);
  yield* runtime.restoreSession(
    notebookUri,
    session.value.executable,
    session.value.workingDirectory,
  );
});

export const shutdownAllSessions = Effect.fn("command.shutdownAllSessions")(
  function* () {
    const code = yield* VsCode;
    const sessions = yield* LiveSessions;
    const runtime = yield* NotebookRuntime;
    const live = yield* sessions.get;
    if (live.length === 0) return;
    if (live.length > 1) {
      const choice = yield* code.window.showWarningMessage(
        `Shut down all ${live.length} live kernels?`,
        { modal: true, items: ["Shut Down All"] },
      );
      if (!Option.contains(choice, "Shut Down All")) return;
    }
    yield* runtime.shutdownAll;
  },
);
