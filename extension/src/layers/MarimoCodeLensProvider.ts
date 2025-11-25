import { Effect, Layer } from "effect";
import type * as vscode from "vscode";
import { VsCode } from "../services/VsCode.ts";

/**
 * Regex to match top-level marimo.App( declaration.
 * Matches: optional whitespace, 'app', optional type annotation, '=', whitespace, 'marimo.App()'
 * Must be at start of line (^) to exclude indented declarations inside functions/classes.
 */
export const MARIMO_APP_REGEX = /^app\s*(?::\s*[^=]+)?\s*=\s*marimo\.App\(/m;

/**
 * Checks if text contains a top-level marimo.App() declaration.
 */
export function isMarimoAppText(text: string): boolean {
  return MARIMO_APP_REGEX.test(text);
}

/**
 * Finds the line number of the marimo app declaration in the given text.
 * Returns undefined if no declaration is found.
 */
export function findMarimoAppLine(text: string): number | undefined {
  const match = MARIMO_APP_REGEX.exec(text);
  if (!match || match.index === undefined) {
    return undefined;
  }
  // Convert string index to line number
  const beforeMatch = text.substring(0, match.index);
  return beforeMatch.split("\n").length - 1;
}

/**
 * Provides a CodeLens above marimo app declarations that allows users to
 * open the Python file as a marimo notebook in VS Code.
 */
export const MarimoCodeLensProviderLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;

    // Helper to check if a text document is a marimo file
    const isMarimoFile = (document: vscode.TextDocument): boolean => {
      // Only check Python files
      if (document.languageId !== "python") {
        return false;
      }

      return isMarimoAppText(document.getText());
    };

    const provider: vscode.CodeLensProvider = {
      provideCodeLenses(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken,
      ): vscode.ProviderResult<vscode.CodeLens[]> {
        // Only provide for marimo files
        if (!isMarimoFile(document)) {
          return [];
        }

        const lineNumber = findMarimoAppLine(document.getText());
        if (lineNumber === undefined) {
          return [];
        }

        // Create a range at the start of the line
        const range = new code.Range(lineNumber, 0, lineNumber, 0);
        const codeLens = new code.CodeLens(range, {
          title: "Open as notebook",
          command: "marimo.openAsMarimoNotebook",
          arguments: [],
        });

        return [codeLens];
      },
    };

    // Register the provider for Python text files only
    const selector = {
      scheme: "file",
      language: "python",
    } satisfies vscode.DocumentSelector;

    yield* code.languages.registerCodeLensProvider(selector, provider);
  }),
);
