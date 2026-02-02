import { Effect, Either, Option, Schema } from "effect";
import { MarimoNotebookDocument } from "../schemas.ts";
import { LanguageClient } from "../services/LanguageClient.ts";
import { VsCode } from "../services/VsCode.ts";
import { showErrorAndPromptLogs } from "../utils/showErrorAndPromptLogs.ts";

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
      Effect.fnUntraced(function* () {
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
