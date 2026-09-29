import * as Vitest from "@effect/vitest";
import { Effect, Option } from "effect";
import type * as vscode from "vscode";

import { extractExecuteCodeRequest } from "../../src/lib/extractExecuteCodeRequest.ts";
import * as Constants from "../../src/platform/Constants.ts";
import { MarimoNotebookCell } from "../../src/schemas/MarimoNotebookDocument.ts";
import type * as Api from "../../src/schemas/Models.gen.ts";
import * as VsCodeValues from "../fake/VsCodeValues.ts";
import * as EffectTest from "./EffectTest.ts";

const notebookUri = VsCodeValues.createNotebookUri(
  "file:///test/notebook_mo.py",
);
const effectIt = EffectTest.make(Constants.defaultLayer);

// Helper to create a raw vscode.NotebookCell (extractExecuteCodeRequest
// consumes raw cells, not MarimoNotebookCell)
function createRawCell(
  value: string,
  metadata: typeof Api.CellMetadata.Encoded,
  index: number,
): vscode.NotebookCell {
  return VsCodeValues.createNotebookCell(
    VsCodeValues.createTestNotebookDocument(notebookUri),
    {
      kind: 2, // Code
      value,
      languageId: "python",
      metadata: MarimoNotebookCell.createMetadata(metadata),
    },
    index,
  );
}

Vitest.describe("extractExecuteCodeRequest", () => {
  effectIt.effect("includes enabled cells with stable ids", () =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants.Service;

      const cellA = createRawCell(
        "x = 1",
        { marimoRuntime: { stableId: "cell-a" } },
        0,
      );
      const cellB = createRawCell(
        "y = x + 1",
        { marimoRuntime: { stableId: "cell-b" } },
        1,
      );

      const request = extractExecuteCodeRequest([cellA, cellB], LanguageId);

      Vitest.expect(Option.isSome(request)).toBe(true);
      Vitest.expect(Option.getOrThrow(request).cells).toEqual([
        { cellId: "cell-a", code: "x = 1" },
        { cellId: "cell-b", code: "y = x + 1" },
      ]);
    }),
  );

  effectIt.effect("skips cells without a stable id", () =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants.Service;

      const withId = createRawCell(
        "x = 1",
        { marimoRuntime: { stableId: "cell-a" } },
        0,
      );
      const withoutId = createRawCell("y = 2", {}, 1);

      const request = extractExecuteCodeRequest(
        [withId, withoutId],
        LanguageId,
      );

      Vitest.expect(Option.isSome(request)).toBe(true);
      Vitest.expect(
        Option.getOrThrow(request).cells.map((cell) => cell.cellId),
      ).toEqual(["cell-a"]);
    }),
  );

  // Disabled cells still submit edited code to marimo. The runtime updates its
  // graph before enforcing the disabled config, matching marimo's editor.
  effectIt.effect("includes disabled cells", () =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants.Service;

      const enabled = createRawCell(
        "x = 1",
        { marimoRuntime: { stableId: "cell-enabled" } },
        0,
      );
      const disabled = createRawCell(
        'print("RAN")',
        {
          marimo: { options: { disabled: true } },
          marimoRuntime: { stableId: "cell-disabled" },
        },
        1,
      );

      const request = extractExecuteCodeRequest(
        [enabled, disabled],
        LanguageId,
      );

      Vitest.expect(Option.getOrThrow(request)).toEqual({
        cells: [
          { cellId: "cell-enabled", code: "x = 1" },
          { cellId: "cell-disabled", code: 'print("RAN")' },
        ],
      });
    }),
  );

  effectIt.effect("submits a selection containing only a disabled cell", () =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants.Service;

      const disabled = createRawCell(
        'print("RAN")',
        {
          marimo: { options: { disabled: true } },
          marimoRuntime: { stableId: "cell-disabled" },
        },
        0,
      );

      const request = extractExecuteCodeRequest([disabled], LanguageId);

      Vitest.expect(Option.getOrThrow(request)).toEqual({
        cells: [{ cellId: "cell-disabled", code: 'print("RAN")' }],
      });
    }),
  );
});
