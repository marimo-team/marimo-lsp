import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref } from "effect";
import { TestClock } from "effect/testing";

import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import {
  createTestNotebookDocument,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { CellStatusBarProviderLive } from "../../features/CellStatusBarProvider.ts";
import { CellExecutions } from "../../kernel/CellExecutions.ts";
import { NotebookEditorRegistry } from "../../notebook/NotebookEditorRegistry.ts";
import { VsCode } from "../../platform/VsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../../schemas/MarimoNotebookDocument.ts";
import { makeCellHarness } from "./CellExecutionsHarness.ts";

const withTestCtx = Effect.fn(function* () {
  const vscode = yield* TestVsCode.make();
  const layer = Layer.empty.pipe(
    Layer.provideMerge(CellStatusBarProviderLive),
    Layer.provideMerge(CellExecutions.layer),
    Layer.provide(NotebookEditorRegistry.layer),
    Layer.provideMerge(vscode.layer),
    Layer.provide(TestTelemetryLive),
  );
  return { vscode, layer };
});

describe("CellExecutions staleness", () => {
  it.effect(
    "getNotebookCellId returns consistent cell IDs",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;

        const cellData0 = new code.NotebookCellData(
          code.NotebookCellKind.Code,
          "x = 1",
          "python",
        );
        cellData0.metadata = MarimoNotebookCell.createMetadata({
          marimoRuntime: { stableId: "cell-0" },
        });

        const cellData1 = new code.NotebookCellData(
          code.NotebookCellKind.Code,
          "y = 2",
          "python",
        );
        cellData1.metadata = MarimoNotebookCell.createMetadata({
          marimoRuntime: { stableId: "cell-1" },
        });

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
    "updates marimo.notebook.hasStaleCells context when cell is invalidated",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const executions = yield* CellExecutions;
        const cells = makeCellHarness(executions);

        const cellData0 = new code.NotebookCellData(
          code.NotebookCellKind.Code,
          "x = 1",
          "python",
        );
        cellData0.metadata = MarimoNotebookCell.createMetadata({
          marimoRuntime: { stableId: "cell-0" },
        });

        const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
          data: new code.NotebookData([cellData0]),
        });

        yield* ctx.vscode.addNotebookDocument(editor.notebook);
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("10 millis");

        const notebook = MarimoNotebookDocument.from(editor.notebook);
        const cell = notebook.cellAt(0);

        // Execute the cell, then invalidate (simulates staleInputs)
        yield* cells.acceptSource(cell);
        yield* TestClock.adjust("10 millis");

        // Clear previous context updates
        yield* Ref.update(ctx.vscode.executions, () => []);

        // Invalidate → cell becomes stale → hasStaleCells should be true
        yield* cells.markStale(cell);
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
    "clears stale when queued cell is edited and re-run (regression: #352)",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const executions = yield* CellExecutions;
        const cells = makeCellHarness(executions);

        // Cell B, depends on a slow cell A elsewhere. Starts with original code.
        const cellDataB = new code.NotebookCellData(
          code.NotebookCellKind.Code,
          "y = x + 1",
          "python",
        );
        cellDataB.metadata = MarimoNotebookCell.createMetadata({
          marimoRuntime: { stableId: "cell-b" },
        });

        const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
          data: new code.NotebookData([cellDataB]),
        });

        yield* ctx.vscode.addNotebookDocument(editor.notebook);
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("10 millis");

        const notebook = MarimoNotebookDocument.from(editor.notebook);
        const cellB = notebook.cellAt(0);

        // 1. B is queued as a reactive descendant of slow cell A — the kernel
        //    acks "queued" for B with the original code.
        yield* cells.acceptSource(cellB);
        yield* TestClock.adjust("10 millis");
        expect(yield* cells.isStale(cellB)).toBe(false);

        // 2. User edits B while it is still queued waiting for A to finish.
        //    The document text changes; fire a notebookChange so derivations run.
        cellDataB.value = "y = x + 2";
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

        // Editor code now differs from what the kernel last ran → stale.
        expect(yield* cells.isStale(cellB)).toBe(true);

        // 3. User presses Ctrl+Enter on B. Extension sends a new run request
        //    with the new code; the kernel's queued ack accepts the new source.
        yield* cells.acceptSource(cellB);
        yield* TestClock.adjust("10 millis");

        // 4. Stale should clear immediately — regardless of whether the kernel
        //    happens to run B once more with the old code under the hood.
        expect(yield* cells.isStale(cellB)).toBe(false);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "never-executed cell is not stale",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const executions = yield* CellExecutions;
        const cells = makeCellHarness(executions);

        const cellData = new code.NotebookCellData(
          code.NotebookCellKind.Code,
          "x = 1",
          "python",
        );
        cellData.metadata = MarimoNotebookCell.createMetadata({
          marimoRuntime: { stableId: "cell-0" },
        });

        const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
          data: new code.NotebookData([cellData]),
        });
        yield* ctx.vscode.addNotebookDocument(editor.notebook);
        yield* TestClock.adjust("10 millis");

        const cell = MarimoNotebookDocument.from(editor.notebook).cellAt(0);
        expect(yield* cells.isStale(cell)).toBe(false);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "re-executing after invalidation clears stale",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const executions = yield* CellExecutions;
        const cells = makeCellHarness(executions);

        const cellData = new code.NotebookCellData(
          code.NotebookCellKind.Code,
          "x = 1",
          "python",
        );
        cellData.metadata = MarimoNotebookCell.createMetadata({
          marimoRuntime: { stableId: "cell-0" },
        });

        const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
          data: new code.NotebookData([cellData]),
        });
        yield* ctx.vscode.addNotebookDocument(editor.notebook);
        yield* TestClock.adjust("10 millis");

        const cell = MarimoNotebookDocument.from(editor.notebook).cellAt(0);

        yield* cells.acceptSource(cell);
        yield* cells.markStale(cell);
        yield* TestClock.adjust("10 millis");
        expect(yield* cells.isStale(cell)).toBe(true);

        yield* cells.acceptSource(cell);
        yield* TestClock.adjust("10 millis");
        expect(yield* cells.isStale(cell)).toBe(false);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "reverting cell text to last-executed code clears stale (regression: #309, #323)",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const executions = yield* CellExecutions;
        const cells = makeCellHarness(executions);

        const cellData = new code.NotebookCellData(
          code.NotebookCellKind.Code,
          "x = 1",
          "python",
        );
        cellData.metadata = MarimoNotebookCell.createMetadata({
          marimoRuntime: { stableId: "cell-0" },
        });

        const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
          data: new code.NotebookData([cellData]),
        });
        yield* ctx.vscode.addNotebookDocument(editor.notebook);
        yield* TestClock.adjust("10 millis");

        const cell = MarimoNotebookDocument.from(editor.notebook).cellAt(0);

        yield* cells.acceptSource(cell);
        yield* TestClock.adjust("10 millis");

        // Edit away — cell becomes stale.
        cellData.value = "x = 2";
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
        expect(yield* cells.isStale(cell)).toBe(true);

        // Undo back to the executed text — stale clears without re-running.
        cellData.value = "x = 1";
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
        expect(yield* cells.isStale(cell)).toBe(false);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "editing one cell does not affect another cell's stale state",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const executions = yield* CellExecutions;
        const cells = makeCellHarness(executions);

        const cellDataA = new code.NotebookCellData(
          code.NotebookCellKind.Code,
          "a = 1",
          "python",
        );
        cellDataA.metadata = MarimoNotebookCell.createMetadata({
          marimoRuntime: { stableId: "cell-a" },
        });
        const cellDataB = new code.NotebookCellData(
          code.NotebookCellKind.Code,
          "b = 2",
          "python",
        );
        cellDataB.metadata = MarimoNotebookCell.createMetadata({
          marimoRuntime: { stableId: "cell-b" },
        });

        const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
          data: new code.NotebookData([cellDataA, cellDataB]),
        });
        yield* ctx.vscode.addNotebookDocument(editor.notebook);
        yield* TestClock.adjust("10 millis");

        const notebook = MarimoNotebookDocument.from(editor.notebook);
        const cellA = notebook.cellAt(0);
        const cellB = notebook.cellAt(1);

        yield* cells.acceptSource(cellA);
        yield* cells.acceptSource(cellB);
        yield* TestClock.adjust("10 millis");

        // Edit A only; B must remain not-stale.
        cellDataA.value = "a = 99";
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

        expect(yield* cells.isStale(cellA)).toBe(true);
        expect(yield* cells.isStale(cellB)).toBe(false);

        // Invalidating A must also not touch B.
        yield* cells.markStale(cellA);
        yield* TestClock.adjust("10 millis");
        expect(yield* cells.isStale(cellB)).toBe(false);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "hasStaleCells context flips true on invalidate and back to false on re-execute",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      const hasStaleCellsContextValues = (
        executions: ReadonlyArray<{
          command: string;
          args: ReadonlyArray<unknown>;
        }>,
      ): ReadonlyArray<boolean> =>
        executions.flatMap((e) =>
          e.command === "setContext" &&
          e.args[0] === "marimo.notebook.hasStaleCells" &&
          typeof e.args[1] === "boolean"
            ? [e.args[1]]
            : [],
        );

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const executions = yield* CellExecutions;
        const cells = makeCellHarness(executions);

        const cellData = new code.NotebookCellData(
          code.NotebookCellKind.Code,
          "x = 1",
          "python",
        );
        cellData.metadata = MarimoNotebookCell.createMetadata({
          marimoRuntime: { stableId: "cell-0" },
        });

        const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
          data: new code.NotebookData([cellData]),
        });
        yield* ctx.vscode.addNotebookDocument(editor.notebook);
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("10 millis");

        const cell = MarimoNotebookDocument.from(editor.notebook).cellAt(0);

        // Start from a clean slate, then record the initial execution.
        yield* cells.acceptSource(cell);
        yield* TestClock.adjust("10 millis");
        yield* Ref.update(ctx.vscode.executions, () => []);

        // Invalidate → stale → context must flip to true.
        yield* cells.markStale(cell);
        yield* TestClock.adjust("10 millis");
        expect(
          hasStaleCellsContextValues(yield* Ref.get(ctx.vscode.executions)).at(
            -1,
          ),
        ).toBe(true);

        // Re-execute → stale clears → context must flip back to false.
        yield* cells.acceptSource(cell);
        yield* TestClock.adjust("10 millis");
        expect(
          hasStaleCellsContextValues(yield* Ref.get(ctx.vscode.executions)).at(
            -1,
          ),
        ).toBe(false);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "does not mark cell stale when content matches last executed (undo case)",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const executions = yield* CellExecutions;
        const cells = makeCellHarness(executions);

        const cellData0 = new code.NotebookCellData(
          code.NotebookCellKind.Code,
          "x = 1",
          "python",
        );
        cellData0.metadata = MarimoNotebookCell.createMetadata({
          marimoRuntime: { stableId: "cell-0" },
        });

        const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
          data: new code.NotebookData([cellData0]),
        });

        yield* ctx.vscode.addNotebookDocument(editor.notebook);
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("10 millis");

        const notebook = MarimoNotebookDocument.from(editor.notebook);
        const cell0 = notebook.cellAt(0);

        // A queued ack stores the source accepted by the kernel.
        yield* cells.acceptSource(cell0);
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

        // Should NOT be stale since content matches last executed
        expect(yield* cells.isStale(cell0)).toBe(false);

        // The hasStaleCells context should NOT have been set to true
        const commandExecutions = yield* Ref.get(ctx.vscode.executions);
        const hasStaleCellsUpdates = commandExecutions.filter(
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
