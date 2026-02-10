import { Effect, Option, Stream } from "effect";
import type * as vscode from "vscode";
import { assert } from "../assert.ts";
import { dynamicCommand } from "../commands.ts";
import { NOTEBOOK_TYPE } from "../constants.ts";
import {
  type CellMetadata,
  encodeCellMetadata,
  MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../schemas.ts";
import { VsCode } from "./VsCode.ts";

/**
 * Configuration for a metadata binding
 */
export interface MetadataBinding {
  /**
   * Unique identifier for this binding
   */
  id: string;

  /**
   * Type of the binding
   */
  type: "toggle" | "text" | "option";

  /**
   * Predicate to determine if this binding applies to the cell
   * (e.g., check if cell language is SQL)
   */
  shouldShow: (cell: MarimoNotebookCell) => boolean;

  /**
   * Get the current value from cell metadata
   */
  getValue: (metadata: CellMetadata) => string | boolean | undefined;

  /**
   * Update the cell metadata with a new value
   */
  setValue: (metadata: CellMetadata, value: string | boolean) => CellMetadata;

  /**
   * Create the status bar item label based on the current value
   */
  getLabel: (value: string | boolean | undefined) => string;

  /**
   * Tooltip for the status bar item
   */
  getTooltip: (value: string | boolean | undefined) => string;

  /**
   * Alignment of the status bar item
   */
  alignment: vscode.NotebookCellStatusBarAlignment;

  /**
   * For text bindings: prompt shown in the input box
   */
  inputPrompt?: string;

  /**
   * For text bindings: placeholder text in the input box
   */
  inputPlaceholder?: string;

  /**
   * For text bindings: default value when creating new
   */
  defaultValue?: string;

  /**
   * For text bindings: validation function
   */
  validateInput?: (value: string) => string | undefined;

  /**
   * For option bindings: get available options
   */
  getOptions?: (
    cell: MarimoNotebookCell,
  ) => Effect.Effect<Array<{ label: string; value: string }>, never, never>;
}

/**
 * Service that manages two-way bindings between cell metadata and UI elements.
 *
 * This service:
 * - Creates status bar items for metadata fields
 * - Handles clicks to update metadata (toggles or text inputs)
 * - Updates UI when metadata changes
 *
 * Usage:
 * 1. Register bindings using the MetadataBinding interface
 * 2. The service automatically creates status bar items and commands
 * 3. Updates flow bidirectionally between UI and metadata
 */
export class CellMetadataUIBindingService extends Effect.Service<CellMetadataUIBindingService>()(
  "CellMetadataUIBindingService",
  {
    scoped: Effect.gen(function*() {
      const code = yield* VsCode;
      const bindings = new Map<string, MetadataBinding>();

      // Track metadata change events to trigger re-rendering
      const onDidChangeCellStatusBarItems = new code.EventEmitter<void>();

      // Listen to notebook document changes and emit events
      yield* Effect.forkScoped(
        code.workspace.notebookDocumentChanges().pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              const notebook = MarimoNotebookDocument.tryFrom(event.notebook);

              // Only process marimo notebooks
              if (Option.isNone(notebook)) {
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
       * Register a new metadata binding
       */
      const registerBinding = (binding: MetadataBinding) =>
        Effect.gen(function*() {
          bindings.set(binding.id, binding);

          // Create command for handling clicks
          const commandId = dynamicCommand(`cell.metadata.${binding.id}`);
          yield* code.commands.registerCommand(commandId, createBindingCommandFor(binding));

          // Create provider for status bar item
          const provider: vscode.NotebookCellStatusBarItemProvider = {
            onDidChangeCellStatusBarItems: onDidChangeCellStatusBarItems.event,
            provideCellStatusBarItems(
              rawCell: vscode.NotebookCell,
              _token: vscode.CancellationToken,
            ): vscode.ProviderResult<vscode.NotebookCellStatusBarItem[]> {
              const cell = MarimoNotebookCell.from(rawCell);

              if (!binding.shouldShow(cell)) {
                return [];
              }

              const value = Option.isSome(cell.metadata)
                ? binding.getValue(cell.metadata.value)
                : undefined;

              const item = new code.NotebookCellStatusBarItem(
                binding.getLabel(value),
                binding.alignment,
              );
              item.tooltip = binding.getTooltip(value);
              item.command = commandId;

              return [item];
            },
          };

          // Register the provider
          yield* code.notebooks.registerNotebookCellStatusBarItemProvider(NOTEBOOK_TYPE, provider);
        });

      /**
       * Create a command handler for a binding
       */
      function createBindingCommandFor(binding: MetadataBinding) {
        return Effect.fn(function*() {
          const editor = yield* code.window.getActiveNotebookEditor();

          if (Option.isNone(editor)) {
            return;
          }

          // Get the active cell
          const notebook = MarimoNotebookDocument.tryFrom(editor.value.notebook);

          if (Option.isNone(notebook)) {
            return;
          }

          const activeCell = notebook.value.cellAt(editor.value.selection.start);

          if (!binding.shouldShow(activeCell)) {
            return;
          }

          const currentValue = Option.isSome(activeCell.metadata)
            ? binding.getValue(activeCell.metadata.value)
            : undefined;

          let newValue: string | boolean | undefined;

          if (binding.type === "toggle") {
            // Toggle the boolean value
            newValue = !currentValue;
          } else if (binding.type === "option") {
            // Show quick pick for options
            assert(binding.getOptions !== undefined, "getOptions is required for option bindings");
            const options = yield* binding.getOptions(activeCell);

            const selected = yield* code.window.showQuickPick(
              options.map((opt) => opt.label),
              {
                placeHolder: binding.inputPlaceholder ?? "Select an option",
              },
            );

            if (Option.isNone(selected)) {
              // User cancelled
              return;
            }

            // Find the value from the label
            const selectedOption = options.find((opt) => opt.label === selected.value);
            if (!selectedOption) {
              return;
            }
            newValue = selectedOption.value;
          } else {
            // Show input box for text
            const input = yield* code.window.showInputBox({
              prompt: binding.inputPrompt ?? "Enter value",
              value: typeof currentValue === "string" ? currentValue : undefined,
              placeHolder: binding.inputPlaceholder ?? binding.defaultValue ?? "",
              validateInput: binding.validateInput
                ? (value) => {
                  assert(binding.validateInput !== undefined, "validateInput is required");
                  const error = binding.validateInput(value);
                  return error ? error : undefined;
                }
                : undefined,
            });

            if (Option.isNone(input)) {
              // User cancelled
              return;
            }

            newValue = input.value;
          }

          assert(newValue !== undefined, "newValue should not be undefined");

          // Update the cell metadata
          const currentMetadata = Option.isSome(activeCell.metadata)
            ? activeCell.metadata.value
            : {};
          let updatedMetadata = binding.setValue(currentMetadata, newValue);
          // Mark stale
          updatedMetadata = {
            ...updatedMetadata,
            state: "stale",
          };

          const edit = new code.WorkspaceEdit();
          const cellData = new code.NotebookCellData(
            activeCell.kind,
            activeCell.document.getText(),
            activeCell.document.languageId,
          );
          cellData.metadata = encodeCellMetadata(updatedMetadata);
          cellData.outputs = Array.from(activeCell.outputs);

          edit.set(editor.value.notebook.uri, [
            code.NotebookEdit.replaceCells(
              new code.NotebookRange(activeCell.index, activeCell.index + 1),
              [cellData],
            ),
          ]);

          yield* code.workspace.applyEdit(edit);

          // Re-execute the cell to apply the metadata changes
          yield* code.commands.executeCommand("notebook.cell.execute", {
            ranges: [
              {
                start: activeCell.index,
                end: activeCell.index + 1,
              },
            ],
          });

          yield* Effect.logInfo(`Updated cell metadata for binding: ${binding.id}`).pipe(
            Effect.annotateLogs({
              cell: activeCell.index,
              newValue,
            }),
          );
        });
      }

      return { registerBinding } as const;
    }),
  },
) {
}
