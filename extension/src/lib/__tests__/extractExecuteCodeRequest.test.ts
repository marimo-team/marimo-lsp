import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import type * as vscode from "vscode";

import {
  createNotebookCell,
  createNotebookUri,
  createTestNotebookDocument,
} from "../../__mocks__/TestVsCode.ts";
import { Constants } from "../../platform/Constants.ts";
import type { CellMetadata } from "../../schemas/CellMetadata.ts";
import { extractExecuteCodeRequest } from "../extractExecuteCodeRequest.ts";

const notebookUri = createNotebookUri("file:///test/notebook_mo.py");

// Helper to create a raw vscode.NotebookCell (extractExecuteCodeRequest
// consumes raw cells, not MarimoNotebookCell)
function createRawCell(
  value: string,
  metadata: Partial<CellMetadata>,
  index: number,
): vscode.NotebookCell {
  return createNotebookCell(
    createTestNotebookDocument(notebookUri),
    {
      kind: 2, // Code
      value,
      languageId: "python",
      metadata,
    },
    index,
  );
}

describe("extractExecuteCodeRequest", () => {
  it.effect("includes enabled cells with stable ids", () =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants;

      const cellA = createRawCell("x = 1", { stableId: "cell-a" }, 0);
      const cellB = createRawCell("y = x + 1", { stableId: "cell-b" }, 1);

      const request = extractExecuteCodeRequest([cellA, cellB], LanguageId);

      expect(Option.isSome(request)).toBe(true);
      const { codes, cellIds } = Option.getOrThrow(request);
      expect(cellIds).toEqual(["cell-a", "cell-b"]);
      expect(codes).toEqual(["x = 1", "y = x + 1"]);
    }).pipe(Effect.provide(Constants.Default)),
  );

  it.effect("skips cells without a stable id", () =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants;

      const withId = createRawCell("x = 1", { stableId: "cell-a" }, 0);
      const withoutId = createRawCell("y = 2", {}, 1);

      const request = extractExecuteCodeRequest(
        [withId, withoutId],
        LanguageId,
      );

      expect(Option.isSome(request)).toBe(true);
      const { cellIds } = Option.getOrThrow(request);
      expect(cellIds).toEqual(["cell-a"]);
    }).pipe(Effect.provide(Constants.Default)),
  );

  // Regression test for https://github.com/marimo-team/marimo-lsp/issues/154
  // A cell authored as `@app.cell(disabled=True)` reaches the extension with
  // metadata.options = { disabled: true } (set by NotebookSerializer from the
  // LSP server's deserialize response). It must NOT be sent for execution.
  it.effect(
    "excludes cells disabled via @app.cell(disabled=True) (issue #154)",
    () =>
      Effect.gen(function* () {
        const { LanguageId } = yield* Constants;

        const enabled = createRawCell("x = 1", { stableId: "cell-enabled" }, 0);
        const disabled = createRawCell(
          'print("RAN")',
          { stableId: "cell-disabled", options: { disabled: true } },
          1,
        );

        const request = extractExecuteCodeRequest(
          [enabled, disabled],
          LanguageId,
        );

        expect(Option.isSome(request)).toBe(true);
        const { codes, cellIds } = Option.getOrThrow(request);
        expect(cellIds).toContain("cell-enabled");
        expect(cellIds).not.toContain("cell-disabled");
        expect(codes).not.toContain('print("RAN")');
      }).pipe(Effect.provide(Constants.Default)),
  );

  // Once disabled cells are filtered, a selection of only disabled cells
  // produces an empty request, which must be Option.none() so the controller
  // stops instead of sending an empty execute-cells request (issue #154).
  it.effect("returns none when every selected cell is disabled", () =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants;

      const disabled = createRawCell(
        'print("RAN")',
        { stableId: "cell-disabled", options: { disabled: true } },
        0,
      );

      const request = extractExecuteCodeRequest([disabled], LanguageId);

      expect(Option.isNone(request)).toBe(true);
    }).pipe(Effect.provide(Constants.Default)),
  );
});
