import { Effect, Option } from "effect";

import type { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import type { CellOperationNotification } from "../../types.ts";
import { CellExecutions, CellInput, type Drive } from "../CellExecutions.ts";

const noDrive: Drive = () => Effect.void;

export function makeCellHarness(executions: CellExecutions["Service"]) {
  let nextRunId = 0;

  const accept = (
    cell: MarimoNotebookCell,
    operation: Omit<CellOperationNotification, "op" | "cell_id">,
    drive: Drive = noDrive,
  ) => {
    const cellId = Option.getOrThrow(cell.id);
    return executions.accept(
      CellInput.Operation({
        notebookId: cell.notebook.id,
        operation: { op: "cell-op", cell_id: cellId, ...operation },
        source: cell.document.getText(),
        drive,
      }),
    );
  };

  return {
    accept,
    acceptSource: (cell: MarimoNotebookCell) =>
      accept(cell, {
        status: "queued",
        run_id: `test-run-${nextRunId++}`,
      }),
    markStale: (cell: MarimoNotebookCell) =>
      accept(cell, { stale_inputs: true }),
    isStale: (cell: MarimoNotebookCell) =>
      Option.match(cell.id, {
        onNone: () => Effect.succeed(false),
        onSome: (cellId) =>
          executions.isStale({
            notebookId: cell.notebook.id,
            cellId,
            source: cell.document.getText(),
          }),
      }),
  };
}
