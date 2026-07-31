import { Effect, Option } from "effect";

import type { NotebookCommandContext } from "../commands.ts";
import { CellExecutions } from "../kernel/CellExecutions.ts";
import { getNotebookCommandEditor } from "../lib/getNotebookCommandEditor.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { SessionsService } from "../panel/sessions/SessionsService.ts";
import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";

export const restartKernel = Effect.fn("command.restartKernel")(function* (
  context?: NotebookCommandContext,
) {
  const code = yield* VsCode;
  const sessions = yield* SessionsService;
  const executions = yield* CellExecutions;

  const editor = yield* getNotebookCommandEditor(context);
  if (Option.isNone(editor)) {
    yield* code.window.showInformationMessage(
      "No notebook editor is currently open",
    );
    return;
  }

  const notebook = MarimoNotebookDocument.tryFrom(editor.value.notebook);
  if (Option.isNone(notebook)) {
    yield* code.window.showInformationMessage(
      "No marimo notebook is currently open",
    );
    return;
  }

  if (Option.isNone(yield* sessions.find(notebook.value.id))) {
    yield* code.window.showInformationMessage(
      "This notebook does not have a live kernel",
    );
    return;
  }

  const restarted = yield* code.window.withProgress(
    {
      location: code.ProgressLocation.Window,
      title: "Restarting kernel",
      cancellable: false,
    },
    Effect.fn(function* (progress) {
      progress.report({ message: "Restarting session..." });

      const succeeded = yield* sessions.restart(notebook.value.id).pipe(
        Effect.as(true),
        Effect.catchAllCause(
          Effect.fn(function* (cause) {
            yield* Effect.logError("Failed to restart kernel").pipe(
              Effect.annotateLogs({ cause }),
            );
            yield* showErrorAndPromptLogs("Failed to restart kernel.");
            return false;
          }),
        ),
      );

      if (!succeeded) return false;

      yield* executions.handleInterrupt(editor.value);

      progress.report({ message: "Kernel restarted." });
      yield* Effect.sleep("500 millis");
      return true;
    }),
  );

  if (restarted) {
    yield* code.window.showInformationMessage("Kernel restarted successfully");
  }
});
