import { Effect, Either, Option } from "effect";

import { MarimoNotebookDocument } from "../schemas.ts";
import { ExecutionRegistry } from "../services/ExecutionRegistry.ts";
import { LanguageClient } from "../services/LanguageClient.ts";
import { VsCode } from "../services/VsCode.ts";
import { showErrorAndPromptLogs } from "../utils/showErrorAndPromptLogs.ts";

export const restartKernel = Effect.fn("command.restartKernel")(function* () {
  const code = yield* VsCode;
  const client = yield* LanguageClient;
  const executions = yield* ExecutionRegistry;

  const editor = yield* code.window.getActiveNotebookEditor();
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

  yield* code.window.withProgress(
    {
      location: code.ProgressLocation.Window,
      title: "Restarting kernel",
      cancellable: true,
    },
    Effect.fnUntraced(function* (progress) {
      progress.report({ message: "Closing session..." });

      const result = yield* client
        .executeCommand({
          command: "marimo.api",
          params: {
            method: "close-session",
            params: {
              notebookUri: notebook.value.id,
              inner: {},
            },
          },
        })
        .pipe(Effect.either);

      if (Either.isLeft(result)) {
        yield* Effect.logFatal("Failed to restart kernel", result.left);
        yield* showErrorAndPromptLogs("Failed to restart kernel.");
        return;
      }

      yield* executions.handleInterrupted(editor.value);

      // Clear all cell outputs by replacing each cell with fresh version
      const edit = new code.WorkspaceEdit();
      const cells = editor.value.notebook.getCells();
      const freshCells = cells.map((cell) => {
        const freshCell = new code.NotebookCellData(
          cell.kind,
          cell.document.getText(),
          cell.document.languageId,
        );
        freshCell.metadata = cell.metadata;
        return freshCell;
      });
      edit.set(editor.value.notebook.uri, [
        code.NotebookEdit.replaceCells(
          new code.NotebookRange(0, cells.length),
          freshCells,
        ),
      ]);
      yield* code.workspace.applyEdit(edit);

      progress.report({ message: "Kernel restarted." });
      yield* Effect.sleep("500 millis");
    }),
  );

  yield* code.window.showInformationMessage("Kernel restarted successfully");
});
