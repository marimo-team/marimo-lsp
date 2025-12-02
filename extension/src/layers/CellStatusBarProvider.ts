import { Effect, Layer, Option, Stream } from "effect";
import type * as vscode from "vscode";
import { NOTEBOOK_TYPE, SETUP_CELL_NAME } from "../constants.ts";
import { MarimoNotebookCell, MarimoNotebookDocument } from "../schemas.ts";
import { VsCode } from "../services/VsCode.ts";

const DEFAULT_NAME = "_";

/**
 * Provides status bar items for notebook cells, showing staleness and custom cell names.
 *
 * Listens to cell metadata changes and updates the status bar accordingly.
 */
export const CellStatusBarProviderLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;

    // Track metadata change events to trigger re-rendering
    const onDidChangeCellStatusBarItems = new code.EventEmitter<void>();

    // Listen to notebook document changes and emit events
    yield* Effect.forkScoped(
      code.workspace.notebookDocumentChanges().pipe(
        Stream.runForEach(
          Effect.fnUntraced(function* (event) {
            const notebook =
              MarimoNotebookDocument.decodeUnknownNotebookDocument(
                event.notebook,
              );

            if (Option.isNone(notebook)) {
              // not a marimo notebook
              return;
            }

            // Only process metadata changes
            const hasMetadataChanges = event.cellChanges.some(
              (change) => change.metadata !== undefined,
            );

            if (hasMetadataChanges) {
              onDidChangeCellStatusBarItems.fire();
            }
          }),
        ),
      ),
    );

    /**
     * Creates a provider for a specific status bar item type
     */
    function createProvider(
      provide: (
        cell: MarimoNotebookCell,
      ) => vscode.NotebookCellStatusBarItem | undefined,
    ): vscode.NotebookCellStatusBarItemProvider {
      return {
        onDidChangeCellStatusBarItems: onDidChangeCellStatusBarItems.event,
        provideCellStatusBarItems(
          cell: vscode.NotebookCell,
          _token: vscode.CancellationToken,
        ): vscode.ProviderResult<vscode.NotebookCellStatusBarItem[]> {
          const item = provide(MarimoNotebookCell.from(cell));
          return item ? [item] : [];
        },
      };
    }

    /**
     * Provider for staleness indicator
     */
    const stalenessProvider = createProvider((cell) => {
      if (!cell.isStale) {
        return undefined;
      }

      const item = new code.NotebookCellStatusBarItem(
        "$(warning) Stale",
        code.NotebookCellStatusBarAlignment.Right,
      );
      item.tooltip = "Cell has been edited but not re-executed";
      item.command = "marimo.runStale";

      return item;
    });

    /**
     * Provider for cell name indicator
     */
    const nameProvider = createProvider(({ name }) => {
      if (Option.isNone(name) || name.value === DEFAULT_NAME) {
        return undefined;
      }

      if (name.value === SETUP_CELL_NAME) {
        const item = new code.NotebookCellStatusBarItem(
          `$(gear) ${SETUP_CELL_NAME}`,
          code.NotebookCellStatusBarAlignment.Left,
        );
        item.tooltip = `Setup cell`;
        return item;
      }

      const item = new code.NotebookCellStatusBarItem(
        `$(symbol-variable) ${name.value}`,
        code.NotebookCellStatusBarAlignment.Left,
      );
      item.tooltip = `Cell name: ${name.value}`;

      return item;
    });

    // register providers
    yield* code.notebooks.registerNotebookCellStatusBarItemProvider(
      NOTEBOOK_TYPE,
      stalenessProvider,
    );
    yield* code.notebooks.registerNotebookCellStatusBarItemProvider(
      NOTEBOOK_TYPE,
      nameProvider,
    );
  }),
);
