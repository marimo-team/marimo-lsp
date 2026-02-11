import { Effect, Option } from "effect";

import type { MarimoConfig } from "../types.ts";

import { MarimoNotebookDocument } from "../schemas.ts";
import { MarimoConfigurationService } from "../services/config/MarimoConfigurationService.ts";
import { VsCode } from "../services/VsCode.ts";
import { showErrorAndPromptLogs } from "../utils/showErrorAndPromptLogs.ts";

/**
 * Generic configuration toggle function for marimo config options.
 * Creates a handler that shows a quick pick dialog with all available options.
 */
export const createConfigToggle = <T extends string>({
  configPath,
  getCurrentValue,
  choices,
  getDisplayName,
}: {
  configPath: string;
  getCurrentValue: (config: MarimoConfig) => T;
  choices: ReadonlyArray<{
    label: string;
    detail: string;
    value: T;
  }>;
  getDisplayName: (value: T) => string;
}) =>
  Effect.gen(function* () {
    const code = yield* VsCode;
    const configService = yield* MarimoConfigurationService;

    // Validate active notebook
    const notebook = Option.filterMap(
      yield* code.window.getActiveNotebookEditor(),
      (editor) => MarimoNotebookDocument.tryFrom(editor.notebook),
    );

    if (Option.isNone(notebook)) {
      yield* showErrorAndPromptLogs(
        `Must have an open marimo notebook to toggle ${configPath}.`,
      );
      return;
    }

    // Fetch current configuration
    const config = yield* configService.getConfig(notebook.value.id);
    const currentValue = getCurrentValue(config);

    // Show quick pick with all choices, marking current
    const choice = yield* code.window.showQuickPickItems(
      choices.map((c) => ({
        label: c.label,
        description: c.value === currentValue ? "$(check) Current" : undefined,
        detail: c.detail,
        value: c.value,
      })),
    );

    if (Option.isNone(choice)) {
      return; // User cancelled
    }

    const newValue = choice.value.value;

    if (newValue === currentValue) {
      yield* Effect.logInfo("Value unchanged");
      return;
    }

    // Update configuration
    yield* Effect.logInfo(`Updating ${configPath}`).pipe(
      Effect.annotateLogs({
        notebook: notebook.value.id,
        from: currentValue,
        to: newValue,
      }),
    );

    // Build nested config object from path (e.g., "runtime.on_cell_change" -> { runtime: { on_cell_change: value }})
    const pathParts = configPath.split(".");
    const partialConfig = pathParts.reduceRight(
      (acc, part) => ({ [part]: acc }),
      newValue as unknown as Record<string, unknown>,
    );

    yield* configService.updateConfig(notebook.value.id, partialConfig);

    yield* code.window.showInformationMessage(
      `${configPath} updated to: ${getDisplayName(newValue)}`,
    );
  }).pipe(
    Effect.tapErrorCause(Effect.logError),
    Effect.catchAllCause(() =>
      showErrorAndPromptLogs(`Failed to toggle ${configPath}.`),
    ),
  );
