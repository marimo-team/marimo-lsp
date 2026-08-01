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
    let document: Option.Option<vscode.TextDocument> = Option.none();
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
      document = Option.some(editor.value.document);
    } else {
      uri = resource;
    }

    // Locate the open text document for this URI when we were not handed one
    // directly (string or explicit URI invocations).
    if (Option.isNone(document)) {
      const docs = yield* code.workspace.getTextDocuments();
      document = Option.fromNullable(
        docs.find((doc) => doc.uri.toString() === uri.toString()),
      );
    }

    // Persist unsaved edits before opening the file as a notebook. The notebook
    // is deserialized from the file on disk, and opening it closes the original
    // text editor. If the buffer is dirty and we do not save first, VS Code
    // prompts to save on close; declining discards the unsaved content and the
    // notebook opens with no cells. Saving first guarantees no data loss. See
    // https://github.com/marimo-team/marimo-lsp/issues/531.
    if (Option.isSome(document) && document.value.isDirty) {
      const doc = document.value;
      const saved = yield* Effect.promise(() => doc.save());
      if (!saved) {
        yield* code.window.showInformationMessage(
          "Failed to save changes before opening as a notebook",
        );
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
