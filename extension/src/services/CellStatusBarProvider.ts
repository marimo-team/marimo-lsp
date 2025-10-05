import { Effect, Option, Stream } from "effect";
import type * as vscode from "vscode";
import { NOTEBOOK_TYPE } from "../constants.ts";
import { decodeCellMetadata, isStaleCellMetadata } from "../schemas.ts";
import { VsCode } from "./VsCode.ts";

/**
 * Provides status bar items for notebook cells, showing a stale indicator
 * when cells have been edited but not re-executed.
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
          Stream.mapEffect(
            Effect.fnUntraced(function* (event) {
              // Only process metadata changes
              const hasMetadataChanges = event.cellChanges.some(
                (change) => change.metadata !== undefined,
              );

              if (hasMetadataChanges) {
                onDidChangeCellStatusBarItems.fire();
              }
            }),
          ),
          Stream.runDrain,
        ),
      );

      const provider: vscode.NotebookCellStatusBarItemProvider = {
        onDidChangeCellStatusBarItems: onDidChangeCellStatusBarItems.event,

        provideCellStatusBarItems(
          cell: vscode.NotebookCell,
          _token: vscode.CancellationToken,
        ): vscode.ProviderResult<
          vscode.NotebookCellStatusBarItem | vscode.NotebookCellStatusBarItem[]
        > {
          const metadata = decodeCellMetadata(cell.metadata);

          // No metadata or not stale - don't show anything
          if (Option.isNone(metadata)) {
            return [];
          }

          if (!isStaleCellMetadata(metadata.value)) {
            return [];
          }

          // Create stale indicator
          const item = new code.NotebookCellStatusBarItem(
            "$(warning) Stale",
            code.NotebookCellStatusBarAlignment.Right,
          );
          item.tooltip = "Cell has been edited but not re-executed";
          item.command = "marimo.runStale";

          return [item];
        },
      };

      // Register the provider
      const disposable =
        yield* code.notebooks.registerNotebookCellStatusBarItemProvider(
          NOTEBOOK_TYPE,
          provider,
        );

      return disposable;
    }).pipe(Effect.annotateLogs("service", "CellStatusBarProvider")),
  },
) {}
