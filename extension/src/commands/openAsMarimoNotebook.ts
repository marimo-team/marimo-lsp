import { Effect, Either, Option, Schema } from "effect";
import type * as vscode from "vscode";

import { NOTEBOOK_TYPE } from "../constants.ts";
import { VsCode } from "../platform/VsCode.ts";
import { defineCommand } from "./defineCommand.ts";

const UriSchema = Schema.declare<vscode.Uri>(
  (value): value is vscode.Uri =>
    typeof value === "object" &&
    value !== null &&
    "scheme" in value &&
    typeof value.scheme === "string" &&
    "path" in value &&
    typeof value.path === "string" &&
    "with" in value &&
    typeof value.with === "function" &&
    "toString" in value &&
    typeof value.toString === "function",
  { identifier: "vscode.Uri" },
);

export const openAsMarimoNotebook = defineCommand(
  Schema.UndefinedOr(Schema.Union(Schema.String, UriSchema)),
  Effect.fn("command.openAsMarimoNotebook")(function* (resource) {
    const code = yield* VsCode;

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
    yield* code.commands.executeCommand("vscode.openWith", uri, NOTEBOOK_TYPE);

    // Find and close the original text editor tab (not the notebook we just opened).
    // We find the tab after opening the notebook because tab references can become
    // stale when VS Code reorganizes tabs.
    yield* code.window.closeTextEditorTab(uri);

    yield* Effect.logDebug("Opened Python file as marimo notebook").pipe(
      Effect.annotateLogs({ uri: uri.toString() }),
    );
  }),
);
