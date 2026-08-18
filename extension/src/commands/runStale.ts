import { Effect, flow, Option } from "effect";

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

    const staleCells = yield* Effect.filter(
      target.value.document.getCells(),
      (cell) =>
        Option.match(cell.id, {
          onNone: () => Effect.succeed(false),
          onSome: (cellId) =>
            executions.isStale({
              notebookId: cell.notebook.id,
              cellId,
              source: cell.document.getText(),
            }),
        }),
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
