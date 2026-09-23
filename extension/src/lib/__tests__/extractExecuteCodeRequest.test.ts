import { describe, expect } from "@effect/vitest";
import { Effect, Option } from "effect";
import type * as vscode from "vscode";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import * as Constants from "../../platform/Constants.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import type * as Api from "../../schemas/Models.gen.ts";
import { extractExecuteCodeRequest } from "../extractExecuteCodeRequest.ts";

const notebookUri = TestVsCode.createNotebookUri("file:///test/notebook_mo.py");
const effectIt = EffectTest.make(Constants.defaultLayer);

// Helper to create a raw vscode.NotebookCell (extractExecuteCodeRequest
// consumes raw cells, not MarimoNotebookCell)
function createRawCell(
  value: string,
  metadata: typeof Api.CellMetadata.Encoded,
  index: number,
): vscode.NotebookCell {
  return TestVsCode.createNotebookCell(
    TestVsCode.createTestNotebookDocument(notebookUri),
    {
      kind: 2, // Code
      value,
      languageId: "python",
      metadata: MarimoNotebookCell.createMetadata(metadata),
    },
    index,
  );
}

describe("extractExecuteCodeRequest", () => {
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

      expect(Option.isSome(request)).toBe(true);
      expect(Option.getOrThrow(request).cells).toEqual([
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

      expect(Option.isSome(request)).toBe(true);
      expect(
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

      expect(Option.getOrThrow(request)).toEqual({
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

      expect(Option.getOrThrow(request)).toEqual({
        cells: [{ cellId: "cell-disabled", code: 'print("RAN")' }],
      });
    }),
  );
});
