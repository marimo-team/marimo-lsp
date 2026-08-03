import { Cause, Effect, Either, Option } from "effect";
import type * as vscode from "vscode";

import { NOTEBOOK_TYPE } from "../constants.ts";
import { MarimoClient, MarimoClientStartError } from "../lsp/MarimoClient.ts";
import { VsCode } from "../platform/VsCode.ts";

const CONVERT_COPY = "Convert a copy";
const KEEP_TEXT = "Keep open as text";

export const openAsMarimoNotebook = Effect.fn("command.openAsMarimoNotebook")(
  function* (resource?: string | vscode.Uri) {
    const code = yield* VsCode;
    const marimo = yield* MarimoClient;

    let uri: vscode.Uri;
    if (typeof resource === "string") {
      const result = code.utils.parseUri(resource);
      if (Either.isLeft(result)) {
        yield* code.window.showInformationMessage(
          `Failed to parse notebook URI: ${JSON.stringify(resource)}`,
        );
        return;
      }
      uri = result.right;
    } else if (resource === undefined) {
      const editor = yield* code.window.getActiveTextEditor();
      if (Option.isNone(editor)) {
        yield* code.window.showInformationMessage(
          "No active file to open as notebook",
        );
        return;
      }
      uri = editor.value.document.uri;
    } else {
      uri = resource;
    }

    const documents = yield* code.workspace.getTextDocuments();
    const document = documents.find(
      (document) => document.uri.toString() === uri.toString(),
    );

    const source =
      document?.getText() ??
      new TextDecoder().decode(yield* code.workspace.fs.readFile(uri));
    const inspection = yield* Effect.either(marimo.deserialize({ source }));

    if (Either.isLeft(inspection)) {
      const error = inspection.left;
      yield* Effect.logError(
        "Failed to inspect file before notebook open",
      ).pipe(
        Effect.annotateLogs({
          cause: Cause.fail(error),
          "rpc.method": "deserialize",
        }),
      );
      const message =
        error instanceof MarimoClientStartError
          ? "The marimo language server couldn't start, so this file couldn't be checked. The file remains open as text."
          : "marimo couldn't inspect this file before opening it as a notebook. The file remains open as text.";
      const selection = yield* code.window.showErrorMessage(
        `${message}\n\nSee ${marimo.channel.name} logs for details.`,
        { items: ["Open Logs"] },
      );
      if (Option.isSome(selection)) marimo.channel.show();
      return;
    }

    const result = inspection.right;
    if (result.kind === "invalid-syntax") {
      const location = result.line === null ? "" : ` at line ${result.line}`;
      yield* code.window.showErrorMessage(
        `This file can't be opened as a marimo notebook because it has a Python syntax error${location}.`,
      );
      return;
    }

    if (result.kind !== "success") {
      const message =
        result.kind === "unsupported-format"
          ? "This file uses Jupytext percent format, not the native marimo notebook format."
          : "This is a Python script, not a native marimo notebook.";
      const selection = yield* code.window.showInformationMessage(message, {
        items: [CONVERT_COPY, KEEP_TEXT],
      });
      if (Option.contains(selection, CONVERT_COPY)) {
        yield* code.commands.executeVSCode("marimo.convert", {
          uri: uri.toString(),
        });
      }
      return;
    }

    // `vscode.openWith` deserializes the notebook from disk, so persist any
    // in-memory edits before switching editors.
    if (document?.isDirty) {
      const saved = yield* Effect.promise(() => document.save());
      if (!saved) {
        return;
      }
    }

    // We open first before closing to handle multi-window scenarios correctly:
    // if we close first and it's the only editor in the window, the window
    // closes before we can open the notebook in it.
    yield* code.commands.executeVSCode("vscode.openWith", uri, NOTEBOOK_TYPE);

    // Find and close the original text editor tab (not the notebook we just opened).
    // We find the tab after opening the notebook because tab references can become
    // stale when VS Code reorganizes tabs.
    yield* code.window.closeTextEditorTab(uri);

    yield* Effect.logDebug("Opened Python file as marimo notebook").pipe(
      Effect.annotateLogs({ uri: uri.toString() }),
    );
  },
);
