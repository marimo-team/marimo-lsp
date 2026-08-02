import { Effect, Option, Stream } from "effect";
import type * as vscode from "vscode";

import { assert } from "../assert.ts";
import { commandId } from "../commands.ts";
import { MarimoCommands } from "../commands/MarimoCommands.ts";
import { NOTEBOOK_TYPE } from "../constants.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../schemas/MarimoNotebookDocument.ts";
import * as Api from "../schemas/Models.gen.ts";
import { updateMarimoCellMetadata } from "./updateMarimoCellMetadata.ts";

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
  getValue: (metadata: Api.MarimoCellMetadata) => string | boolean | undefined;

  /**
   * Update the cell metadata with a new value
   */
  setValue: (
    metadata: Api.MarimoCellMetadata,
    value: string | boolean,
  ) => Api.MarimoCellMetadata;

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
  ) => Effect.Effect<Array<{ label: string; value: string }>>;
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
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const bindings = new Map<string, MetadataBinding>();

      // Stream that fires when metadata changes on any marimo notebook cell
      const metadataChanges = code.workspace.notebookDocumentChanges().pipe(
        Stream.filter((event) => {
          if (Option.isNone(MarimoNotebookDocument.tryFrom(event.notebook))) {
            return false;
          }
          return event.cellChanges.some(
            (change) => change.metadata !== undefined,
          );
        }),
      );

      /**
       * Register a new metadata binding
       */
      const registerBinding = (binding: MetadataBinding) =>
        Effect.gen(function* () {
          bindings.set(binding.id, binding);

          // Register the provider
          yield* code.notebooks.registerNotebookCellStatusBarItemProvider(
            NOTEBOOK_TYPE,
            {
              provideCellStatusBarItems(rawCell) {
                const cell = MarimoNotebookCell.from(rawCell);

                if (!binding.shouldShow(cell)) {
                  return Effect.succeed([]);
                }

                const value = Option.isSome(cell.metadata)
                  ? binding.getValue(cell.metadata.value.marimo)
                  : undefined;

                const item = new code.NotebookCellStatusBarItem(
                  binding.getLabel(value),
                  binding.alignment,
                );
                item.tooltip = binding.getTooltip(value);
                item.command = {
                  command: commandId(MarimoCommands.updateCellMetadata),
                  title: "Update cell metadata",
                  arguments: [binding.id],
                };

                return Effect.succeed([item]);
              },
              changes: metadataChanges,
            },
          );
        });

      /**
       * Create a command handler for a binding
       */
      function createBindingCommandFor(binding: MetadataBinding) {
        return Effect.fn(function* () {
          const editor = yield* code.window.getActiveNotebookEditor();

          if (Option.isNone(editor)) {
            return;
          }

          // Get the active cell
          const notebook = MarimoNotebookDocument.tryFrom(
            editor.value.notebook,
          );

          if (Option.isNone(notebook)) {
            return;
          }

          const activeCell = notebook.value.cellAt(
            editor.value.selection.start,
          );

          if (!binding.shouldShow(activeCell)) {
            return;
          }

          const currentValue = Option.isSome(activeCell.metadata)
            ? binding.getValue(activeCell.metadata.value.marimo)
            : undefined;

          let newValue: string | boolean | undefined;

          if (binding.type === "toggle") {
            // Toggle the boolean value
            newValue = !currentValue;
          } else if (binding.type === "option") {
            // Show quick pick for options
            assert(
              binding.getOptions !== undefined,
              "getOptions is required for option bindings",
            );
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
            const selectedOption = options.find(
              (opt) => opt.label === selected.value,
            );
            if (!selectedOption) {
              return;
            }
            newValue = selectedOption.value;
          } else {
            // Show input box for text
            const input = yield* code.window.showInputBox({
              prompt: binding.inputPrompt ?? "Enter value",
              value:
                typeof currentValue === "string" ? currentValue : undefined,
              placeHolder:
                binding.inputPlaceholder ?? binding.defaultValue ?? "",
              validateInput: binding.validateInput
                ? (value) => {
                    assert(
                      binding.validateInput !== undefined,
                      "validateInput is required",
                    );
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

          yield* updateMarimoCellMetadata(activeCell, (current) =>
            binding.setValue(current, newValue),
          ).pipe(Effect.provideService(VsCode, code));

          // Re-execute the cell to apply the metadata changes
          yield* code.commands.executeVSCode("notebook.cell.execute", {
            ranges: [
              {
                start: activeCell.index,
                end: activeCell.index + 1,
              },
            ],
          });

          yield* Effect.logInfo(
            `Updated cell metadata for binding: ${binding.id}`,
          ).pipe(
            Effect.annotateLogs({
              cell: activeCell.index,
              newValue,
            }),
          );
        });
      }

      yield* code.commands.register(
        MarimoCommands.updateCellMetadata,
        Effect.fn(function* (bindingId) {
          const binding = bindings.get(bindingId);
          if (binding === undefined) {
            yield* Effect.logWarning("Unknown cell metadata binding").pipe(
              Effect.annotateLogs({ bindingId }),
            );
            return;
          }
          yield* createBindingCommandFor(binding)();
        }),
      );

      return { registerBinding } as const;
    }),
  },
) {}
