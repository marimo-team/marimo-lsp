import { Effect, flow, HashSet, Option } from "effect";

import { defineCommand } from "../commands.ts";
import { CellExecutions } from "../kernel/CellExecutions.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { VsCode } from "../platform/VsCode.ts";
import type { NotebookTarget } from "./Invocation.ts";
import { MarimoCommands } from "./MarimoCommands.ts";

const handler = Effect.fn("command.runStale")(
  function* (target: Option.Option<NotebookTarget>) {
    const code = yield* VsCode;
    const executions = yield* CellExecutions;

    if (Option.isNone(target)) {
      yield* showErrorAndPromptLogs(
        "Must have an open marimo notebook to run stale cells.",
      );
      return;
    }

    const notebookExecutions = executions.find(
      target.value.document.rawNotebookDocument,
    );
    const staleIds = Option.isSome(notebookExecutions)
      ? yield* notebookExecutions.value.staleCells.current
      : HashSet.empty();
    const staleCells = target.value.document
      .getCells()
      .filter((cell) =>
        Option.exists(cell.id, (cellId) => HashSet.has(staleIds, cellId)),
      );

    if (staleCells.length === 0) {
      yield* Effect.logInfo("No stale cells found");
      yield* code.window.showInformationMessage("No stale cells to run");
      return;
    }

    yield* Effect.logInfo("Running stale cells").pipe(
      Effect.annotateLogs({
        staleCount: staleCells.length,
        notebook: target.value.document.id,
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
    Effect.tapCause(Effect.logError),
    Effect.catchCause(() =>
      showErrorAndPromptLogs("Failed to run stale cells."),
    ),
  ),
);

export default defineCommand(MarimoCommands.runStale, handler);
