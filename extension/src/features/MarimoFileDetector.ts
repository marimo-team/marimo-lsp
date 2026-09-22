import { Effect, Layer, Option, Stream } from "effect";
import type * as vscode from "vscode";

import * as VsCode from "../platform/VsCode.ts";
import * as MarimoCodeLensProvider from "./MarimoCodeLensProvider.ts";

/**
 * Detects if the active Python file is a marimo notebook and sets context
 * to show/hide the "Open as Notebook" button in the editor title.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode.Service;

    // Helper to check if a text document is a marimo notebook
    const isMarimoFile = (document: vscode.TextDocument): boolean => {
      // Only check Python files
      if (document.languageId !== "python") {
        return false;
      }

      return MarimoCodeLensProvider.isAppText(document.getText());
    };

    // Update context based on active editor
    const updateContext = Effect.fn("MarimoFileDetector.updateContext")(
      function* (editor: Option.Option<vscode.TextEditor>) {
        const isMarimoNotebook = Option.match(editor, {
          onNone: () => false,
          onSome: (ed) => isMarimoFile(ed.document),
        });

        yield* code.commands.setContext(
          "marimo.isPythonFileMarimoNotebook",
          isMarimoNotebook,
        );

        if (isMarimoNotebook) {
          yield* Effect.logDebug("Detected marimo notebook file").pipe(
            Effect.annotateLogs({
              uri: Option.map(editor, (e) => e.document.uri.toString()).pipe(
                Option.getOrThrow,
              ),
            }),
          );
        }
      },
    );

    // Set initial context for current active editor
    yield* updateContext(yield* code.window.getActiveTextEditor);

    // Listen for active text editor changes
    yield* Effect.forkScoped(
      code.window.activeTextEditorChanges.pipe(
        Stream.runForEach(updateContext),
      ),
    );
  }).pipe(Effect.withSpan("MarimoFileDetector.layer")),
);
