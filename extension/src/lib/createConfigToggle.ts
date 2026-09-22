import { Effect, Option, Scope } from "effect";

import * as NotebookConfiguration from "../config/NotebookConfiguration.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import * as NotebookDocumentSessions from "../notebook/NotebookDocumentSessions.ts";
import * as NotebookSessionResources from "../notebook/NotebookSessionResources.ts";
import * as VsCode from "../platform/VsCode.ts";
import type { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";
import type { MarimoConfig } from "../types.ts";

/**
 * Generic configuration toggle function for marimo config options.
 * Creates a handler that shows a quick pick dialog with all available options.
 */
export const createConfigToggle = <T extends string>({
  notebook,
  configPath,
  settingName,
  pickerTitle,
  getCurrentValue,
  choices,
  getDisplayName,
}: {
  notebook: Option.Option<MarimoNotebookDocument>;
  configPath: string;
  settingName: string;
  pickerTitle: string;
  getCurrentValue: (config: MarimoConfig) => T;
  choices: ReadonlyArray<{
    label: string;
    detail: string;
    value: T;
  }>;
  getDisplayName: (value: T) => string;
}) =>
  Effect.gen(function* () {
    const code = yield* VsCode.Service;
    const documentSessions = yield* NotebookDocumentSessions.Service;
    const sessionResources = yield* NotebookSessionResources.Service;

    if (Option.isNone(notebook)) {
      yield* showErrorAndPromptLogs(
        `Open a marimo notebook to configure ${settingName.toLowerCase()}.`,
      );
      return;
    }

    const session = documentSessions.forDocument(
      notebook.value.rawNotebookDocument,
    );
    if (Option.isNone(session)) {
      yield* showErrorAndPromptLogs(
        `Open a marimo notebook to configure ${settingName.toLowerCase()}.`,
      );
      return;
    }

    yield* sessionResources
      .runScoped(
        session.value,
        Effect.gen(function* () {
          const configuration = yield* NotebookConfiguration.Service;
          const config = yield* configuration.get;
          const currentValue = getCurrentValue(config);

          const choice = yield* code.window.showQuickPickItems(
            choices.map((c) => ({
              label: c.label,
              description:
                c.value === currentValue ? "$(check) Current" : undefined,
              detail: c.detail,
              value: c.value,
            })),
            { title: pickerTitle },
          );

          if (Option.isNone(choice)) return;

          const newValue = choice.value.value;
          if (newValue === currentValue) {
            yield* Effect.logInfo("Value unchanged");
            return;
          }

          yield* Effect.logInfo(`Updating ${configPath}`).pipe(
            Effect.annotateLogs({
              notebook: notebook.value.id,
              from: currentValue,
              to: newValue,
            }),
          );

          const pathParts = configPath.split(".");
          let partialConfig: Record<string, unknown> = {
            [pathParts[pathParts.length - 1]]: newValue,
          };
          for (let i = pathParts.length - 2; i >= 0; i--) {
            partialConfig = { [pathParts[i]]: partialConfig };
          }

          yield* configuration.update(partialConfig);

          yield* code.window.showInformationMessage(
            `${settingName} set to ${getDisplayName(newValue)}.`,
          );
        }),
      )
      .pipe(Scope.provide(session.value.scope));
  }).pipe(
    Effect.catchTag("NotebookDocumentSessions.EndedError", () => Effect.void),
    Effect.tapCause(Effect.logError),
    Effect.catchCause(() =>
      showErrorAndPromptLogs(`Could not update ${settingName.toLowerCase()}.`),
    ),
  );
