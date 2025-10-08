import { Effect, Option, Stream } from "effect";
import type * as vscode from "vscode";
import { NOTEBOOK_TYPE } from "../constants.ts";
import { decodeCellMetadata, isStaleCellMetadata } from "../schemas.ts";
import { isMarimoNotebookDocument } from "../utils/notebook.ts";
import { VsCode } from "./VsCode.ts";

const DEFAULT_NAME = "_";
const SETUP_CELL_NAME = "setup";

/**
 * Provides status bar items for notebook cells, showing staleness and custom cell names.
 *
 * Listens to cell metadata changes and updates the status bar accordingly.
 */
export class CellStatusBarProvider extends Effect.Service<CellStatusBarProvider>()(
  "CellStatusBarProvider",
  {
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;

      // Track metadata change events to trigger re-rendering
      const onDidChangeCellStatusBarItems = new code.EventEmitter<void>();

      // Listen to notebook document changes and emit events
      yield* Effect.forkScoped(
        code.workspace.notebookDocumentChanges().pipe(
          Stream.map((event) => {
            // Only marimo notebooks
            if (!isMarimoNotebookDocument(event.notebook)) {
              return undefined;
            }

            // Only process metadata changes
            const hasMetadataChanges = event.cellChanges.some(
              (change) => change.metadata !== undefined,
            );

            if (hasMetadataChanges) {
              onDidChangeCellStatusBarItems.fire();
            }
            return undefined;
          }),
          Stream.runDrain,
        ),
      );

      /**
       * Creates a provider for a specific status bar item type
       */
      function createProvider(
        provide: (
          cell: vscode.NotebookCell,
        ) => vscode.NotebookCellStatusBarItem | undefined,
      ): vscode.NotebookCellStatusBarItemProvider {
        return {
          onDidChangeCellStatusBarItems: onDidChangeCellStatusBarItems.event,
          provideCellStatusBarItems(
            cell: vscode.NotebookCell,
            _token: vscode.CancellationToken,
          ): vscode.ProviderResult<vscode.NotebookCellStatusBarItem[]> {
            const item = provide(cell);
            return item ? [item] : [];
          },
        };
      }

      /**
       * Provider for staleness indicator
       */
      const stalenessProvider = createProvider((cell) => {
        const metadata = decodeCellMetadata(cell.metadata);

        if (Option.isNone(metadata) || !isStaleCellMetadata(metadata.value)) {
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
      const nameProvider = createProvider((cell) => {
        const metadata = decodeCellMetadata(cell.metadata);

        if (Option.isNone(metadata)) {
          return undefined;
        }

        const name = metadata.value.name;
        if (!name || name === DEFAULT_NAME) {
          return undefined;
        }

        if (name === SETUP_CELL_NAME) {
          const item = new code.NotebookCellStatusBarItem(
            `$(gear) ${SETUP_CELL_NAME}`,
            code.NotebookCellStatusBarAlignment.Left,
          );
          item.tooltip = `Setup cell`;
          return item;
        }

        const item = new code.NotebookCellStatusBarItem(
          `$(symbol-variable) ${name}`,
          code.NotebookCellStatusBarAlignment.Left,
        );
        item.tooltip = `Cell name: ${name}`;

        return item;
      });

      // Register both providers
      const stalenessDisposable =
        yield* code.notebooks.registerNotebookCellStatusBarItemProvider(
          NOTEBOOK_TYPE,
          stalenessProvider,
        );

      const nameDisposable =
        yield* code.notebooks.registerNotebookCellStatusBarItemProvider(
          NOTEBOOK_TYPE,
          nameProvider,
        );

      // Return combined disposable
      return {
        dispose() {
          stalenessDisposable.dispose();
          nameDisposable.dispose();
        },
      };
    }).pipe(Effect.annotateLogs("service", "CellStatusBarProvider")),
  },
) {}
