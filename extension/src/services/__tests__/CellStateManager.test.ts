import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  createTestNotebookDocument,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { getNotebookCellId } from "../../utils/notebook.ts";
import { VsCode } from "../VsCode.ts";

const withTestCtx = Effect.fnUntraced(function* () {
  const vscode = yield* TestVsCode.make();
  return { vscode, layer: vscode.layer };
});

describe("CellStateManager", () => {
  it.effect(
    "getNotebookCellId returns consistent cell IDs",
    Effect.fnUntraced(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;

        // Create a test notebook with cells
        const notebook = createTestNotebookDocument(
          "/test/notebook.py",
          new code.NotebookData([
            new code.NotebookCellData(
              code.NotebookCellKind.Code,
              "x = 1",
              "python",
            ),
            new code.NotebookCellData(
              code.NotebookCellKind.Code,
              "y = 2",
              "python",
            ),
          ]),
        );

        const cell0 = notebook.cellAt(0);
        const cell1 = notebook.cellAt(1);

        // Get cell IDs
        const cellId0 = getNotebookCellId(cell0);
        const cellId1 = getNotebookCellId(cell1);

        // Verify cell IDs are strings and different
        expect(typeof cellId0).toBe("string");
        expect(typeof cellId1).toBe("string");
        expect(cellId0).not.toBe(cellId1);

        // Verify calling getNotebookCellId again returns the same ID
        expect(getNotebookCellId(cell0)).toBe(cellId0);
        expect(getNotebookCellId(cell1)).toBe(cellId1);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );
});
