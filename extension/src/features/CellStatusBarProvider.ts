import { Effect, HashSet, Layer, Option, Stream } from "effect";
import type * as vscode from "vscode";

import enableCell from "../commands/enableCell.ts";
import runStale from "../commands/runStale.ts";
import { NOTEBOOK_TYPE, SETUP_CELL_NAME } from "../constants.ts";
import * as CellExecutions from "../kernel/CellExecutions.ts";
import * as VsCode from "../platform/VsCode.ts";
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
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode.Service;
    const executions = yield* CellExecutions.Service;

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

    const provideStaleItems = Effect.fn(
      "CellStatusBarProvider.provideStaleItems",
    )(function* (raw: vscode.NotebookCell) {
      const cell = MarimoNotebookCell.from(raw);
      const notebookExecutions = executions.find(raw.notebook);
      if (Option.isNone(notebookExecutions)) return [];

      const staleCells = yield* notebookExecutions.value.staleCells.current;
      const stale = Option.exists(cell.id, (cellId) =>
        HashSet.has(staleCells, cellId),
      );
      if (!stale) return [];

      const item = new code.NotebookCellStatusBarItem(
        "$(warning) Stale",
        code.NotebookCellStatusBarAlignment.Right,
      );
      item.tooltip = "Cell has been edited but not re-executed";
      item.command = code.commands.bind(
        runStale.command,
        "Run stale cells",
        raw,
      );
      return [item];
    });

    const provideNameItems = Effect.fn(
      "CellStatusBarProvider.provideNameItems",
    )((raw: vscode.NotebookCell) =>
      Effect.sync(() => {
        const cell = MarimoNotebookCell.from(raw);
        const name = cell.name;
        if (Option.isNone(name) || name.value === DEFAULT_NAME) return [];

        if (name.value === SETUP_CELL_NAME) {
          const item = new code.NotebookCellStatusBarItem(
            `$(gear) ${SETUP_CELL_NAME}`,
            code.NotebookCellStatusBarAlignment.Left,
          );
          item.tooltip = `Setup cell`;
          return [item];
        }

        const item = new code.NotebookCellStatusBarItem(
          `$(symbol-variable) ${name.value}`,
          code.NotebookCellStatusBarAlignment.Left,
        );
        item.tooltip = `Cell name: ${name.value}`;
        return [item];
      }),
    );

    const provideDisabledItems = Effect.fn(
      "CellStatusBarProvider.provideDisabledItems",
    )((raw: vscode.NotebookCell) =>
      Effect.sync(() => {
        const cell = MarimoNotebookCell.from(raw);
        if (!cell.isDisabled) return [];

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
        return [item];
      }),
    );

    // Staleness provider — derived from CellExecutions records
    yield* code.notebooks.registerNotebookCellStatusBarItemProvider(
      NOTEBOOK_TYPE,
      {
        provideCellStatusBarItems: provideStaleItems,
        changes: Stream.merge(
          executions.staleChanges.pipe(Stream.map(() => undefined)),
          metadataChanges,
        ),
      },
    );

    // Cell name provider — reads from cell metadata
    yield* code.notebooks.registerNotebookCellStatusBarItemProvider(
      NOTEBOOK_TYPE,
      {
        provideCellStatusBarItems: provideNameItems,
        changes: metadataChanges,
      },
    );

    // Disabled provider — direct cells can be re-enabled from their status.
    yield* code.notebooks.registerNotebookCellStatusBarItemProvider(
      NOTEBOOK_TYPE,
      {
        provideCellStatusBarItems: provideDisabledItems,
        changes: metadataChanges,
      },
    );
  }).pipe(Effect.withSpan("CellStatusBarProvider.layer")),
);
