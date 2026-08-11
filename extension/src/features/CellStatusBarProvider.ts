import { Effect, Layer, Option, Stream } from "effect";
import type * as vscode from "vscode";

import enableCell from "../commands/enableCell.ts";
import runStale from "../commands/runStale.ts";
import { NOTEBOOK_TYPE, SETUP_CELL_NAME } from "../constants.ts";
import { CellRuns } from "../kernel/CellRuns.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../schemas/MarimoNotebookDocument.ts";

const DEFAULT_NAME = "_";

/**
 * Provides status bar items for notebook cells, showing staleness and custom cell names.
 *
 * Listens to stale state changes and cell metadata changes to update the status bar.
 */
export const CellStatusBarProviderLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const executions = yield* CellRuns;

    // Stream that fires when metadata changes on any marimo notebook cell
    const metadataChanges: Stream.Stream<void> =
      code.workspace.notebookDocumentChanges.pipe(
        Stream.filter((event) => {
          if (Option.isNone(MarimoNotebookDocument.tryFrom(event.notebook))) {
            return false;
          }
          return event.cellChanges.some(
            (change) => change.metadata !== undefined,
          );
        }),
        Stream.map(() => undefined),
      );

    // Staleness provider — derived from CellRuns records
    yield* code.notebooks.registerNotebookCellStatusBarItemProvider(
      NOTEBOOK_TYPE,
      {
        provideCellStatusBarItems(raw) {
          const cell = MarimoNotebookCell.from(raw);
          return executions.isCellStale(cell).pipe(
            Effect.map((stale) => {
              if (!stale) return [];
              const item = new code.NotebookCellStatusBarItem(
                "$(warning) Stale",
                code.NotebookCellStatusBarAlignment.Right,
              );
              item.tooltip = "Cell has been edited but not re-executed";

              // VS Code injects the cell for bare status-bar commands. Bind it
              // explicitly so our typed command contract checks the argument.
              const command: vscode.Command = code.commands.bind(
                runStale.command,
                "Run stale cells",
                raw,
              );
              item.command = command;
              return [item];
            }),
          );
        },
        changes: Stream.merge(executions.changes, metadataChanges),
      },
    );

    // Cell name provider — reads from cell metadata
    yield* code.notebooks.registerNotebookCellStatusBarItemProvider(
      NOTEBOOK_TYPE,
      {
        provideCellStatusBarItems(raw) {
          const cell = MarimoNotebookCell.from(raw);
          const name = cell.name;
          if (Option.isNone(name) || name.value === DEFAULT_NAME) {
            return Effect.succeed([]);
          }

          if (name.value === SETUP_CELL_NAME) {
            const item = new code.NotebookCellStatusBarItem(
              `$(gear) ${SETUP_CELL_NAME}`,
              code.NotebookCellStatusBarAlignment.Left,
            );
            item.tooltip = `Setup cell`;
            return Effect.succeed([item]);
          }

          const item = new code.NotebookCellStatusBarItem(
            `$(symbol-variable) ${name.value}`,
            code.NotebookCellStatusBarAlignment.Left,
          );
          item.tooltip = `Cell name: ${name.value}`;
          return Effect.succeed([item]);
        },
        changes: metadataChanges,
      },
    );

    // Disabled provider — direct cells can be re-enabled from their status.
    yield* code.notebooks.registerNotebookCellStatusBarItemProvider(
      NOTEBOOK_TYPE,
      {
        provideCellStatusBarItems(raw) {
          const cell = MarimoNotebookCell.from(raw);
          if (!cell.isDisabled) return Effect.succeed([]);

          const item = new code.NotebookCellStatusBarItem(
            "$(circle-slash) Disabled",
            code.NotebookCellStatusBarAlignment.Right,
          );
          item.tooltip = "Cell is disabled; click to enable";
          item.command = code.commands.bind(
            enableCell.command,
            "Enable cell",
            raw,
          );
          return Effect.succeed([item]);
        },
        changes: metadataChanges,
      },
    );
  }),
);
