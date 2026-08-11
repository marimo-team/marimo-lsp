import { Effect, Layer, Option, Stream } from "effect";
import type * as vscode from "vscode";

import enableCell from "../commands/enableCell.ts";
import runStale from "../commands/runStale.ts";
import { NOTEBOOK_TYPE, SETUP_CELL_NAME } from "../constants.ts";
import { CellExecutions } from "../kernel/CellExecutions.ts";
import { NotebookEditorRegistry } from "../notebook/NotebookEditorRegistry.ts";
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
    const executions = yield* CellExecutions;
    const editors = yield* NotebookEditorRegistry;

    const isStale = (cell: MarimoNotebookCell) =>
      Option.match(cell.id, {
        onNone: () => Effect.succeed(false),
        onSome: (cellId) =>
          executions.isStale({
            notebookId: cell.notebook.id,
            cellId,
            source: cell.document.getText(),
          }),
      });

    const cellContentChanges: Stream.Stream<void> =
      code.workspace.notebookDocumentChanges.pipe(
        Stream.filter((event) => {
          if (Option.isNone(MarimoNotebookDocument.tryFrom(event.notebook))) {
            return false;
          }
          return event.cellChanges.some(
            (change) => change.document !== undefined,
          );
        }),
        Stream.map(() => undefined),
      );

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

    const updateStaleContext = Effect.fn(function* () {
      const activeNotebook = yield* editors.getActiveNotebookUri;
      const hasStaleCells = yield* Option.match(activeNotebook, {
        onNone: () => Effect.succeed(false),
        onSome: (notebookId) =>
          Effect.gen(function* () {
            const editor = yield* editors.getLastNotebookEditor(notebookId);
            if (Option.isNone(editor)) return false;
            const notebook = MarimoNotebookDocument.tryFrom(
              editor.value.notebook,
            );
            if (Option.isNone(notebook)) return false;
            for (const cell of notebook.value.getCells()) {
              if (yield* isStale(cell)) return true;
            }
            return false;
          }),
      });
      yield* code.commands.setContext(
        "marimo.notebook.hasStaleCells",
        hasStaleCells,
      );
    });

    yield* Effect.forkScoped(
      Stream.merge(
        executions.changes,
        Stream.merge(
          cellContentChanges,
          Stream.map(editors.streamActiveNotebookChanges, () => undefined),
        ),
      ).pipe(Stream.runForEach(updateStaleContext)),
    );

    // Staleness provider — derived from CellExecutions records
    yield* code.notebooks.registerNotebookCellStatusBarItemProvider(
      NOTEBOOK_TYPE,
      {
        provideCellStatusBarItems(raw) {
          const cell = MarimoNotebookCell.from(raw);
          return isStale(cell).pipe(
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
        changes: Stream.merge(
          executions.changes,
          Stream.merge(cellContentChanges, metadataChanges),
        ),
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
