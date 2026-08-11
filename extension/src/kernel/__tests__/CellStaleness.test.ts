import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref } from "effect";
import { TestClock } from "effect/testing";

import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import {
  createTestNotebookDocument,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import {
  CellRunInput,
  type CellRunPresentation,
  CellRuns,
} from "../../kernel/CellRuns.ts";
import { VsCode } from "../../platform/VsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../../schemas/MarimoNotebookDocument.ts";

const withTestCtx = Effect.fn(function* () {
  const vscode = yield* TestVsCode.make();
  const layer = Layer.empty.pipe(
    Layer.merge(CellRuns.layer),
    Layer.provideMerge(vscode.layer),
    Layer.provide(TestTelemetryLive),
  );
  return { vscode, layer };
});

const presentation: CellRunPresentation = {
  apply: () => Effect.void,
};

let nextRunId = 0;

const cellSnapshot = (cell: MarimoNotebookCell) => ({
  notebookId: cell.notebook.id,
  cellId: Option.getOrThrow(cell.id),
  source: cell.document.getText(),
});

const acceptSource = (
  cellRuns: CellRuns["Service"],
  cell: MarimoNotebookCell,
) => {
  const snapshot = cellSnapshot(cell);
  return cellRuns.accept(
    CellRunInput.Operations({
      notebookId: snapshot.notebookId,
      operations: [
        {
          op: "cell-op",
          cell_id: snapshot.cellId,
          status: "queued",
          run_id: `test-run-${nextRunId++}`,
        },
      ],
      sourceByCell: new Map([[snapshot.cellId, snapshot.source]]),
      presentation,
    }),
  );
};

const markStale = (cellRuns: CellRuns["Service"], cell: MarimoNotebookCell) => {
  const snapshot = cellSnapshot(cell);
  return cellRuns.accept(
    CellRunInput.Operations({
      notebookId: snapshot.notebookId,
      operations: [
        {
          op: "cell-op",
          cell_id: snapshot.cellId,
          stale_inputs: true,
        },
      ],
      sourceByCell: new Map([[snapshot.cellId, snapshot.source]]),
      presentation,
    }),
  );
};

describe("CellRuns staleness", () => {
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
    "clears stale when queued cell is edited and re-run (regression: #352)",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const executions = yield* CellRuns;

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
        yield* acceptSource(executions, cellB);
        yield* TestClock.adjust("10 millis");
        expect(yield* executions.isStale(cellSnapshot(cellB))).toBe(false);

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
        expect(yield* executions.isStale(cellSnapshot(cellB))).toBe(true);

        // 3. User presses Ctrl+Enter on B. Extension sends a new run request
        //    with the new code; kernel acks "queued" → acceptSource fires.
        yield* acceptSource(executions, cellB);
        yield* TestClock.adjust("10 millis");

        // 4. Stale should clear immediately — regardless of whether the kernel
        //    happens to run B once more with the old code under the hood.
        expect(yield* executions.isStale(cellSnapshot(cellB))).toBe(false);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "never-executed cell is not stale",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const executions = yield* CellRuns;

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
        expect(yield* executions.isStale(cellSnapshot(cell))).toBe(false);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "re-executing after markStale clears stale",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const executions = yield* CellRuns;

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

        yield* acceptSource(executions, cell);
        yield* markStale(executions, cell);
        yield* TestClock.adjust("10 millis");
        expect(yield* executions.isStale(cellSnapshot(cell))).toBe(true);

        yield* acceptSource(executions, cell);
        yield* TestClock.adjust("10 millis");
        expect(yield* executions.isStale(cellSnapshot(cell))).toBe(false);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "reverting cell text to last-executed code clears stale (regression: #309, #323)",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const executions = yield* CellRuns;

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

        yield* acceptSource(executions, cell);
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
        expect(yield* executions.isStale(cellSnapshot(cell))).toBe(true);

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
        expect(yield* executions.isStale(cellSnapshot(cell))).toBe(false);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "editing one cell does not affect another cell's stale state",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const executions = yield* CellRuns;

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

        yield* acceptSource(executions, cellA);
        yield* acceptSource(executions, cellB);
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

        expect(yield* executions.isStale(cellSnapshot(cellA))).toBe(true);
        expect(yield* executions.isStale(cellSnapshot(cellB))).toBe(false);

        // Invalidating A must also not touch B.
        yield* markStale(executions, cellA);
        yield* TestClock.adjust("10 millis");
        expect(yield* executions.isStale(cellSnapshot(cellB))).toBe(false);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "does not mark cell stale when content matches last executed (undo case)",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const executions = yield* CellRuns;

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

        // Simulate execution: acceptSource stores content as "last executed"
        yield* acceptSource(executions, cell0);
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
        expect(yield* executions.isStale(cellSnapshot(cell0))).toBe(false);

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
