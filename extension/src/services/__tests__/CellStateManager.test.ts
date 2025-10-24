import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, Stream, TestClock } from "effect";
import { TestTelemetry } from "../../__mocks__/TestTelemetry.ts";
import {
  createTestNotebookDocument,
  NotebookRange,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import type { MarimoCommand } from "../../types.ts";
import { getNotebookCellId } from "../../utils/notebook.ts";
import { CellStateManager } from "../CellStateManager.ts";
import { LanguageClient } from "../LanguageClient.ts";
import { VsCode } from "../VsCode.ts";

const withTestCtx = Effect.fnUntraced(function* () {
  const vscode = yield* TestVsCode.make();
  const executions = yield* Ref.make<ReadonlyArray<MarimoCommand>>([]);
  const layer = Layer.empty.pipe(
    Layer.merge(CellStateManager.Default),
    Layer.provideMerge(vscode.layer),
    Layer.provide(TestTelemetry),
    Layer.provide(
      Layer.succeed(
        LanguageClient,
        LanguageClient.make({
          restart: Effect.void,
          executeCommand(cmd) {
            return Ref.update(executions, (arr) => [...arr, cmd]);
          },
          streamOf() {
            return Stream.never;
          },
        }),
      ),
    ),
  );
  return { vscode, layer, executions };
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

  it.effect(
    "deleting cell from notebook sends delete_cell command",
    Effect.fnUntraced(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;

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
            new code.NotebookCellData(
              code.NotebookCellKind.Code,
              "z = 3",
              "python",
            ),
          ]),
        );

        yield* ctx.vscode.addNotebookDocument(notebook);
        yield* TestClock.adjust("10 millis");

        const cellToDelete = notebook.cellAt(1);

        yield* ctx.vscode.notebookChange({
          notebook,
          metadata: undefined,
          cellChanges: [],
          contentChanges: [
            {
              range: new NotebookRange(1, 2), // Delete cell at index 1
              removedCells: [cellToDelete],
              addedCells: [],
            },
          ],
        });

        yield* TestClock.adjust("10 millis");

        const commands = yield* Ref.get(ctx.executions);
        expect(commands).toMatchInlineSnapshot(`
          [
            {
              "command": "marimo.api",
              "params": {
                "method": "delete_cell",
                "params": {
                  "inner": {
                    "cellId": "file:///test/notebook.py#cell-1",
                  },
                  "notebookUri": "file:///test/notebook.py",
                },
              },
            },
          ]
        `);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "updates marimo.notebook.hasStaleCells context when cells become stale",
    Effect.fnUntraced(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;

        const editor = TestVsCode.makeNotebookEditor(
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

        yield* ctx.vscode.addNotebookDocument(editor.notebook);
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("10 millis");

        // Clear all previous executions
        yield* Ref.update(ctx.vscode.executions, () => []);

        // Trigger a cell content change to mark it as stale
        const cell0 = editor.notebook.cellAt(0);
        yield* ctx.vscode.notebookChange({
          notebook: editor.notebook,
          metadata: undefined,
          cellChanges: [
            {
              cell: cell0,
              document: cell0.document,
              metadata: undefined,
              outputs: [],
              executionSummary: undefined,
            },
          ],
          contentChanges: [],
        });

        yield* TestClock.adjust("10 millis");
      }).pipe(Effect.provide(ctx.layer));

      expect(yield* Ref.get(ctx.vscode.executions)).toEqual([
        {
          command: "setContext",
          args: ["marimo.notebook.hasStaleCells", true],
        },
      ]);
    }),
  );
});
