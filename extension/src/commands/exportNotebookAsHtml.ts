import { Effect, Either, Option, Schema } from "effect";

import { defineCommand } from "../commands.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { MarimoClient } from "../lsp/MarimoClient.ts";
import { VsCode } from "../platform/VsCode.ts";
import type { NotebookTarget } from "./Invocation.ts";
import { MarimoCommands } from "./MarimoCommands.ts";

const handler = Effect.fn("command.exportNotebookAsHtml")(function* (
  target: Option.Option<NotebookTarget>,
) {
  const code = yield* VsCode;
  const marimo = yield* MarimoClient;

  if (Option.isNone(target)) {
    yield* code.window.showWarningMessage(
      "Must have an open marimo notebook to export as HTML.",
    );
    return;
  }

  const notebook = target.value.document;
  const hasOutputs = notebook.getCells().some((c) => c.outputs.length > 0);

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
      .parseUri(notebook.uri.toString().replace(/\.py$/, ".html"))
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
      // Call the LSP API to export the notebook
      const result = yield* marimo
        .exportAsHtml({
          notebookUri: notebook.id,
          inner: {
            download: false,
            files: [],
            includeCode: true,
            assetUrl: null,
          },
        })
        .pipe(
          Effect.andThen(Schema.decodeUnknown(Schema.String)),
          Effect.result,
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
                notebook: notebook.id,
                output: saveUri.value.fsPath,
              }),
            ),
          ),
          Effect.tapError(() =>
            Effect.logError("Failed to export notebook as HTML").pipe(
              Effect.annotateLogs({
                notebook: notebook.id,
                output: saveUri.value.fsPath,
              }),
            ),
          ),
          Effect.ignore,
        );
    }),
  );
});

export default defineCommand(MarimoCommands.exportStaticHTML, handler);
