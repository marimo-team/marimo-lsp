import { Effect, flow, Option } from "effect";

import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { CellStateManager } from "../notebook/CellStateManager.ts";
import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";

export const runStale = Effect.fn("command.runStale")(
  function* () {
    const code = yield* VsCode;
    const cellStateManager = yield* CellStateManager;
    const notebook = Option.filterMap(
      yield* code.window.getActiveNotebookEditor(),
      (editor) => MarimoNotebookDocument.tryFrom(editor.notebook),
    );

    if (Option.isNone(notebook)) {
      yield* showErrorAndPromptLogs(
        "Must have an open marimo notebook to run stale cells.",
      );
      return;
    }

    const staleCellIds = new Set(
      yield* cellStateManager.getStaleCells(notebook.value.id),
    );

    if (staleCellIds.size === 0) {
      yield* Effect.logInfo("No stale cells found");
      yield* code.window.showInformationMessage("No stale cells to run");
      return;
    }

    // Map stale cell IDs to their notebook indices
    const staleCells = notebook.value.getCells().filter((cell) =>
      Option.match(cell.id, {
        onSome: (id) => staleCellIds.has(id),
        onNone: () => false,
      }),
    );

    yield* Effect.logInfo("Running stale cells").pipe(
      Effect.annotateLogs({
        staleCount: staleCells.length,
        notebook: notebook.value.id,
      }),
    );

    // Execute stale cells using VS Code's notebook execution command
    yield* code.commands.executeCommand("notebook.cell.execute", {
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
