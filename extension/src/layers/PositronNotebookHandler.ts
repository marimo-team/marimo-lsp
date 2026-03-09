import { Effect, Layer, Option, Stream } from "effect";

import { NOTEBOOK_TYPE } from "../constants.ts";
import { PositronDetection } from "../services/PositronDetection.ts";
import { VsCode } from "../services/VsCode.ts";

/**
 * Handles Positron-specific notebook behavior.
 *
 * Problem: Positron has its own notebook handler for .py files that
 * takes precedence over marimo's handler, preventing marimo notebooks
 * from working correctly.
 *
 * Solution: When a notebook is opened in Positron with a non-marimo
 * controller, check if it's actually a marimo notebook. If so, close
 * it and reopen with marimo's controller.
 */
export const PositronNotebookHandlerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const vscode = yield* VsCode;
    const detection = yield* PositronDetection;

    if (!detection.isPositron) {
      // Not Positron, no need for special handling
      yield* Effect.logDebug("Not running in Positron, skipping handler");
      return;
    }

    yield* Effect.logInfo(
      "Positron detected, installing notebook handler workaround",
      {
        positronVersion: detection.version ?? "unknown",
      },
    );

    // Listen for notebook document opens
    yield* Effect.forkScoped(
      vscode.workspace
        .notebookDocumentOpens()
        .pipe(
          // Filter for non-marimo notebooks (Positron's handler)
          Stream.filter(
            (doc) => doc.notebookType !== NOTEBOOK_TYPE && doc.uri.path.endsWith(".py"),
          ),
          // Check if it's actually a marimo notebook
          Stream.filterEffect(
            Effect.fnUntraced(function* (doc) {
              const text = yield* Effect.promise(() =>
                vscode.workspace.fs.readFile(doc.uri),
              );
              const content = new TextDecoder().decode(text);

              // Check for marimo.App( declaration
              const isMarimoNotebook =
                /^app\s*(?::\s*[^=]+)?\s*=\s*marimo\.App\(/m.test(content);

              if (isMarimoNotebook) {
                yield* Effect.logInfo(
                  "Detected marimo notebook opened with wrong controller",
                  {
                    uri: doc.uri.toString(),
                    notebookType: doc.notebookType,
                  },
                );
              }

              return isMarimoNotebook;
            }),
          ),
          // Reopen with marimo's controller
          Stream.mapEffect(
            Effect.fnUntraced(function* (doc) {
              yield* Effect.logInfo("Reopening notebook with marimo controller", {
                uri: doc.uri.toString(),
              });

              // Close the incorrectly opened notebook
              yield* vscode.commands.executeCommand(
                "workbench.action.closeActiveEditor",
              );

              // Small delay to ensure the editor is closed
              yield* Effect.sleep("100 millis");

              // Reopen as marimo notebook
              yield* vscode.commands.executeCommand(
                "vscode.openWith",
                doc.uri,
                NOTEBOOK_TYPE,
              );
            }),
          ),
          Stream.runDrain,
        ),
    );
  }),
);
