import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, Stream, TestClock } from "effect";
import { TestTelemetry } from "../../__mocks__/TestTelemetry.ts";
import {
  createTestNotebookDocument,
  NotebookRange,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { MarimoNotebookDocument } from "../../schemas.ts";
import type { MarimoCommand } from "../../types.ts";
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
          channel: {
            name: "marimo-lsp",
            show() {},
          },
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

        const cellData0 = new code.NotebookCellData(
          code.NotebookCellKind.Code,
          "x = 1",
          "python",
        );
        cellData0.metadata = { stableId: "cell-0" };

        const cellData1 = new code.NotebookCellData(
          code.NotebookCellKind.Code,
          "y = 2",
          "python",
        );
        cellData1.metadata = { stableId: "cell-1" };

        // Create a test notebook with cells
        const notebook = MarimoNotebookDocument.from(
          createTestNotebookDocument("/test/notebook.py", {
            data: new code.NotebookData([cellData0, cellData1]),
          }),
        );

        const cell0 = notebook.cellAt(0);
        const cell1 = notebook.cellAt(1);

        // Get cell IDs
        const cellId0 = Option.getOrThrow(cell0.id);
        const cellId1 = Option.getOrThrow(cell1.id);

        // Verify cell IDs are strings and different
        expect(typeof cellId0).toBe("string");
        expect(typeof cellId1).toBe("string");
        expect(cellId0).not.toBe(cellId1);

        // Verify calling getNotebookCellId again returns the same ID
        expect(Option.getOrThrow(cell0.id)).toBe(cellId0);
        expect(Option.getOrThrow(cell1.id)).toBe(cellId1);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "deleting cell from notebook sends delete_cell command",
    Effect.fnUntraced(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;

        const cellData0 = new code.NotebookCellData(
          code.NotebookCellKind.Code,
          "x = 1",
          "python",
        );
        cellData0.metadata = { stableId: "cell-0" };

        const cellData1 = new code.NotebookCellData(
          code.NotebookCellKind.Code,
          "y = 2",
          "python",
        );
        cellData1.metadata = { stableId: "cell-1" };

        const cellData2 = new code.NotebookCellData(
          code.NotebookCellKind.Code,
          "z = 3",
          "python",
        );
        cellData2.metadata = { stableId: "cell-2" };

        const notebook = createTestNotebookDocument("/test/notebook.py", {
          data: new code.NotebookData([cellData0, cellData1, cellData2]),
        });

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
                "method": "delete-cell",
                "params": {
                  "inner": {
                    "cellId": "cell-1",
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
    "moving cell does not send delete_cell command",
    Effect.fnUntraced(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;

        const notebook = createTestNotebookDocument("/test/notebook.py", {
          data: new code.NotebookData([
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
        });

        yield* ctx.vscode.addNotebookDocument(notebook);
        yield* TestClock.adjust("10 millis");

        const cellToMove = notebook.cellAt(0);

        // Simulate moving cell from index 0 to index 2
        // VSCode reports this as removed from position 0 and added at position 2
        yield* ctx.vscode.notebookChange({
          notebook,
          metadata: undefined,
          cellChanges: [],
          contentChanges: [
            {
              range: new NotebookRange(0, 1), // Remove from index 0
              removedCells: [cellToMove],
              addedCells: [],
            },
            {
              range: new NotebookRange(2, 2), // Add at index 2
              removedCells: [],
              addedCells: [cellToMove],
            },
          ],
        });

        yield* TestClock.adjust("10 millis");

        const commands = yield* Ref.get(ctx.executions);
        // Should NOT send delete_cell command for moved cells
        expect(commands).toEqual([]);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "updates marimo.notebook.hasStaleCells context when cells become stale",
    Effect.fnUntraced(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;

        const cellData0 = new code.NotebookCellData(
          code.NotebookCellKind.Code,
          "x = 1",
          "python",
        );
        cellData0.metadata = { stableId: "cell-0" };

        const cellData1 = new code.NotebookCellData(
          code.NotebookCellKind.Code,
          "y = 2",
          "python",
        );
        cellData1.metadata = { stableId: "cell-1" };

        const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
          data: new code.NotebookData([cellData0, cellData1]),
        });

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

  it.effect(
    "does not mark cell stale when content matches last executed (undo case)",
    Effect.fnUntraced(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const cellStateManager = yield* CellStateManager;

        const cellData0 = new code.NotebookCellData(
          code.NotebookCellKind.Code,
          "x = 1",
          "python",
        );
        cellData0.metadata = { stableId: "cell-0" };

        const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
          data: new code.NotebookData([cellData0]),
        });

        yield* ctx.vscode.addNotebookDocument(editor.notebook);
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("10 millis");

        const notebook = MarimoNotebookDocument.from(editor.notebook);
        const cell0 = notebook.cellAt(0);
        const cellId = Option.getOrThrow(cell0.id);

        // Simulate execution: clearCellStale stores content as "last executed"
        yield* cellStateManager.clearCellStale(notebook.id, cellId);
        yield* TestClock.adjust("10 millis");

        // Clear previous executions to check fresh state
        yield* Ref.update(ctx.vscode.executions, () => []);

        // Trigger a content change event with the same content (simulating undo)
        // Since content matches last executed, cell should NOT be marked stale
        yield* ctx.vscode.notebookChange({
          notebook: editor.notebook,
          metadata: undefined,
          cellChanges: [
            {
              cell: editor.notebook.cellAt(0),
              document: editor.notebook.cellAt(0).document,
              metadata: undefined,
              outputs: [],
              executionSummary: undefined,
            },
          ],
          contentChanges: [],
        });

        yield* TestClock.adjust("10 millis");

        // Should have NO stale cells since content matches last executed
        const staleCells = yield* cellStateManager.getStaleCells(notebook.id);
        expect(staleCells).not.toContain(cellId);

        // The hasStaleCells context should NOT have been set to true
        const executions = yield* Ref.get(ctx.vscode.executions);
        const hasStaleCellsUpdates = executions.filter(
          (e) =>
            e.command === "setContext" &&
            e.args?.[0] === "marimo.notebook.hasStaleCells",
        );
        // Either no updates, or the last update should be false (not stale)
        if (hasStaleCellsUpdates.length > 0) {
          const lastUpdate =
            hasStaleCellsUpdates[hasStaleCellsUpdates.length - 1];
          expect(lastUpdate.args?.[1]).toBe(false);
        }
      }).pipe(Effect.provide(ctx.layer));
    }),
  );
});
