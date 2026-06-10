import { Effect, Either, Option, Schema } from "effect";

import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { LanguageClient } from "../lsp/LanguageClient.ts";
import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";

const MARIMO_OUTPUT_MIME = "application/vnd.marimo.ui+json";

export const exportNotebookAsHtml = Effect.fn("command.exportNotebookAsHtml")(
  function* () {
    const code = yield* VsCode;
    const client = yield* LanguageClient;
    const notebook = Option.filterMap(
      yield* code.window.getActiveNotebookEditor(),
      (editor) => MarimoNotebookDocument.tryFrom(editor.notebook),
    );

    if (Option.isNone(notebook)) {
      yield* code.window.showWarningMessage(
        "Must have an open marimo notebook to export as HTML.",
      );
      return;
    }

    const hasOutputs = notebook.value
      .getCells()
      .some((c) => c.outputs.length > 0);

    if (!hasOutputs) {
      yield* code.window.showWarningMessage(
        "Cannot export to HTML. Run the notebook to generate outputs first.",
      );
      return;
    }

    // Ask user where to save the file
    const saveUri = yield* code.window.showSaveDialog({
      title: "Export notebook as HTML",
      filters: { HTML: ["html"] },
      defaultUri: code.utils
        .parseUri(notebook.value.uri.toString().replace(/\.py$/, ".html"))
        .pipe(Either.getOrUndefined),
    });

    if (Option.isNone(saveUri)) {
      // User cancelled
      return;
    }

    yield* code.window.withProgress(
      {
        location: code.ProgressLocation.Notification,
        title: "Exporting notebook as HTML",
        cancellable: false,
      },
      Effect.fn(function* () {
        const cellIdsToOutput = collectRenderedCellOutputs(notebook.value);
        if (Object.keys(cellIdsToOutput).length > 0) {
          const syncResult = yield* client
            .executeCommand({
              command: "marimo.api",
              params: {
                method: "update-cell-outputs",
                params: {
                  notebookUri: notebook.value.id,
                  inner: {
                    cellIdsToOutput,
                  },
                },
              },
            })
            .pipe(Effect.either);

          if (Either.isLeft(syncResult)) {
            yield* Effect.logWarning(
              "Could not sync rendered outputs before HTML export",
            );
          }
        }

        // Call the LSP API to export the notebook
        const result = yield* client
          .executeCommand({
            command: "marimo.api",
            params: {
              method: "export-as-html",
              params: {
                notebookUri: notebook.value.id,
                inner: {
                  download: false,
                  files: [],
                  includeCode: true,
                  assetUrl: null,
                },
              },
            },
          })
          .pipe(
            Effect.andThen(Schema.decodeUnknown(Schema.String)),
            Effect.either,
          );

        if (Either.isLeft(result)) {
          yield* Effect.logFatal("Failed to export notebook", result.left);
          yield* showErrorAndPromptLogs("Failed to export notebook as HTML.");
          return;
        }

        // Write the HTML to the file
        yield* code.workspace.fs
          .writeFile(saveUri.value, new TextEncoder().encode(result.right))
          .pipe(
            Effect.tap(() =>
              Effect.logInfo("Exported notebook as HTML").pipe(
                Effect.annotateLogs({
                  notebook: notebook.value.id,
                  output: saveUri.value.fsPath,
                }),
              ),
            ),
            Effect.tapError(() =>
              Effect.logError("Failed to export notebook as HTML").pipe(
                Effect.annotateLogs({
                  notebook: notebook.value.id,
                  output: saveUri.value.fsPath,
                }),
              ),
            ),
            Effect.ignore,
          );
      }),
    );
  },
);

function collectRenderedCellOutputs(notebook: MarimoNotebookDocument) {
  const decoder = new TextDecoder();
  const cellIdsToOutput: Record<string, [string, unknown]> = {};

  for (const cell of notebook.getCells()) {
    const cellId = Option.getOrUndefined(cell.id);
    if (!cellId) {
      continue;
    }

    for (const output of cell.outputs) {
      const marimoItem = output.items.find(
        (item) => item.mime === MARIMO_OUTPUT_MIME,
      );
      if (!marimoItem) {
        continue;
      }

      const renderedOutput = parseRenderedOutput(
        decoder.decode(marimoItem.data),
      );
      if (!renderedOutput) {
        continue;
      }

      cellIdsToOutput[cellId] = renderedOutput;
      break;
    }
  }

  return cellIdsToOutput;
}

function parseRenderedOutput(value: string): [string, unknown] | null {
  const payload = parseJsonRecord(value);
  if (!payload) {
    return null;
  }

  const state = asRecord(payload.state);
  const output = asRecord(state?.output);
  if (!output) {
    return null;
  }

  if (typeof output.mimetype !== "string" || output.data == null) {
    return null;
  }

  return [output.mimetype, output.data];
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}
