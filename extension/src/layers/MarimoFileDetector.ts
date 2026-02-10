import type * as vscode from "vscode";

import { Effect, Layer, Option, Stream } from "effect";

import { VsCode } from "../services/VsCode.ts";

/**
 * Detects if the active Python file is a marimo notebook and sets context
 * to show/hide the "Open as Notebook" button in the editor title.
 */
export const MarimoFileDetectorLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;

    // Helper to check if a text document is a marimo notebook
    const isMarimoFile = (document: vscode.TextDocument): boolean => {
      // Only check Python files
      if (document.languageId !== "python") {
        return false;
      }

      const text = document.getText();

      // Check for top-level marimo.App( declaration (at start of line)
      // This regex matches: optional whitespace, 'app', optional type annotation, '=', whitespace, 'marimo.App()'
      return /^app\s*(?::\s*[^=]+)?\s*=\s*marimo\.App\(/m.test(text);
    };

    // Update context based on active editor
    const updateContext = Effect.fnUntraced(function* (
      editor: Option.Option<vscode.TextEditor>,
    ) {
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
    });

    // Set initial context for current active editor
    yield* updateContext(yield* code.window.getActiveTextEditor());

    // Listen for active text editor changes
    yield* Effect.forkScoped(
      code.window
        .activeTextEditorChanges()
        .pipe(Stream.mapEffect(updateContext), Stream.runDrain),
    );
  }),
);
