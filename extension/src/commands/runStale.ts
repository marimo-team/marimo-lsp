import { Effect, flow, Option } from "effect";

import { CellExecutions } from "../kernel/CellExecutions.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";
import {
  getNotebookCommandEditor,
  type NotebookCommandTarget,
} from "./NotebookCommandTarget.ts";

export const runStale = Effect.fn("command.runStale")(
  function* (context?: NotebookCommandTarget) {
    const code = yield* VsCode;
    const executions = yield* CellExecutions;
    const notebook = Option.filterMap(
      yield* getNotebookCommandEditor(context),
      (editor) => MarimoNotebookDocument.tryFrom(editor.notebook),
    );

    if (Option.isNone(notebook)) {
      yield* showErrorAndPromptLogs(
        "Must have an open marimo notebook to run stale cells.",
      );
      return;
    }

    const staleCells = yield* Effect.filter(notebook.value.getCells(), (cell) =>
      executions.isCellStale(cell),
    );

    if (staleCells.length === 0) {
      yield* Effect.logInfo("No stale cells found");
      yield* code.window.showInformationMessage("No stale cells to run");
      return;
    }

    yield* Effect.logInfo("Running stale cells").pipe(
      Effect.annotateLogs({
        staleCount: staleCells.length,
        notebook: notebook.value.id,
      }),
    );

    yield* code.commands.executeVSCode("notebook.cell.execute", {
      ranges: staleCells.map((cell) => ({
        start: cell.index,
        end: cell.index + 1,
      })),
    });
  },
  flow(
    Effect.tapErrorCause(Effect.logError),
    Effect.catchAllCause(() =>
      showErrorAndPromptLogs("Failed to run stale cells."),
    ),
  ),
);
