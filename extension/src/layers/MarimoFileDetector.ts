import { Effect, Layer, Option, Stream } from "effect";
import type * as vscode from "vscode";

import { NOTEBOOK_TYPE } from "../constants.ts";
import { VsCode } from "../services/VsCode.ts";

/**
 * Detects if the active Python file is a marimo notebook and sets context
 * to show/hide the "Open as Notebook" button in the editor title.
 */
export const MarimoFileDetectorLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;

    // Track URIs currently being auto-opened to prevent re-triggering
    const autoOpeningUris = new Set<string>();

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
    const updateContext = Effect.fn(function* (
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
        const uri = Option.map(editor, (e) => e.document.uri).pipe(
          Option.getOrThrow,
        );

        yield* Effect.logDebug("Detected marimo notebook file").pipe(
          Effect.annotateLogs({ uri: uri.toString() }),
        );

        // Auto-open as notebook if the setting is enabled
        const uriString = uri.toString();
        if (!autoOpeningUris.has(uriString)) {
          const config = yield* code.workspace.getConfiguration("marimo");
          const autoOpen = config.get<boolean>("autoOpenNotebook", false);
          if (autoOpen) {
            autoOpeningUris.add(uriString);
            try {
              yield* code.commands.executeCommand(
                "vscode.openWith",
                uri,
                NOTEBOOK_TYPE,
              );
              yield* code.window.closeTextEditorTab(uri);
              yield* Effect.logInfo(
                "Auto-opened Python file as marimo notebook",
              ).pipe(Effect.annotateLogs({ uri: uriString }));
            } finally {
              autoOpeningUris.delete(uriString);
            }
          }
        }
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
