import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, TestClock } from "effect";

import {
  createNotebookCell,
  createTestNotebookDocument,
  NotebookRange,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import {
  type CellRange,
  hiddenInputCellRanges,
  CellInputVisibilitySyncLive,
} from "../CellInputVisibilitySync.ts";

const cell = (index: number, hideCode: boolean) =>
  MarimoNotebookCell.from(
    createNotebookCell(
      createTestNotebookDocument("/test/notebook_mo.py"),
      {
        kind: 2,
        value: "",
        languageId: "python",
        metadata: MarimoNotebookCell.createMetadata({
          marimo: { options: { hide_code: hideCode } },
          marimoRuntime: { stableId: `cell-${index}` },
        }),
      },
      index,
    ),
  );

describe("hiddenInputCellRanges", () => {
  it("returns one end-exclusive range per hide_code cell, by index", () => {
    const cells = [
      cell(0, false),
      cell(1, true),
      cell(2, false),
      cell(3, true),
    ];
    expect(hiddenInputCellRanges(cells)).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ]);
  });

  it("returns no ranges when no cell hides its code", () => {
    expect(hiddenInputCellRanges([cell(0, false)])).toEqual([]);
  });
});

const isCellRange = (x: unknown): x is CellRange =>
  typeof x === "object" &&
  x !== null &&
  "start" in x &&
  typeof x.start === "number" &&
  "end" in x &&
  typeof x.end === "number";

const collapseRanges = (arg: unknown): readonly CellRange[] | undefined =>
  typeof arg === "object" &&
  arg !== null &&
  "ranges" in arg &&
  Array.isArray(arg.ranges) &&
  arg.ranges.every(isCellRange)
    ? arg.ranges
    : undefined;

/** The ranges passed to a cell-input visibility command, in order. */
const commandRanges = Effect.fn(function* (
  vscode: TestVsCode,
  command: "notebook.cell.collapseCellInput" | "notebook.cell.expandCellInput",
) {
  const executions = yield* Ref.get(vscode.executions);
  return executions
    .filter((e) => e.command === command)
    .map((e) => collapseRanges(e.args[0]));
});

interface CellState {
  readonly stableId: string;
  readonly hideCode: boolean;
}

const makeEditor = (cells: readonly CellState[]) =>
  TestVsCode.makeNotebookEditor("/test/notebook_mo.py", {
    data: {
      cells: cells.map(({ stableId, hideCode: hide_code }) => ({
        kind: 2,
        value: "",
        languageId: "python",
        metadata: MarimoNotebookCell.createMetadata({
          marimo: { options: { hide_code } },
          marimoRuntime: { stableId },
        }),
      })),
    },
  });

const states = (hideCode: ReadonlyArray<boolean>): CellState[] =>
  hideCode.map((hideCode, index) => ({
    stableId: `cell-${index}`,
    hideCode,
  }));

const changeNotebook = (
  vscode: TestVsCode,
  before: readonly CellState[],
  after: readonly CellState[],
) => {
  const previous = makeEditor(before);
  const editor = makeEditor(after);
  return vscode.notebookChange({
    notebook: editor.notebook,
    metadata: undefined,
    cellChanges: [],
    contentChanges: [
      {
        range: new NotebookRange(0, before.length),
        removedCells: Array.from(previous.notebook.getCells()),
        addedCells: Array.from(editor.notebook.getCells()),
      },
    ],
  });
};

const withTestCtx = Effect.fn(function* (hideCode: ReadonlyArray<boolean>) {
  const editor = makeEditor(states(hideCode));
  const vscode = yield* TestVsCode.make({
    initialDocuments: [editor.notebook],
  });
  const layer = CellInputVisibilitySyncLive.pipe(Layer.provide(vscode.layer));
  return { vscode, editor, layer };
});

describe("CellInputVisibilitySync", () => {
  it.scoped(
    "collapses hide_code cells when a notebook first becomes active",
    Effect.fn(function* () {
      const { vscode, editor, layer } = yield* withTestCtx([false, true, true]);

      yield* Effect.gen(function* () {
        yield* vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("1 millis");

        expect(
          yield* commandRanges(vscode, "notebook.cell.collapseCellInput"),
        ).toEqual([
          [
            { start: 1, end: 2 },
            { start: 2, end: 3 },
          ],
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.scoped(
    "collapses once and does not re-collapse on tab refocus",
    Effect.fn(function* () {
      const { vscode, editor, layer } = yield* withTestCtx([true]);

      yield* Effect.gen(function* () {
        yield* vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("1 millis");
        yield* vscode.setActiveNotebookEditor(Option.none());
        yield* TestClock.adjust("1 millis");
        yield* vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("1 millis");

        expect(
          yield* commandRanges(vscode, "notebook.cell.collapseCellInput"),
        ).toEqual([[{ start: 0, end: 1 }]]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.scoped(
    "collapses hidden cells again after the notebook is closed and reopened",
    Effect.fn(function* () {
      const { vscode, editor, layer } = yield* withTestCtx([true]);
      const reopened = makeEditor(states([true]));

      yield* Effect.gen(function* () {
        yield* vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("1 millis");
        yield* vscode.setActiveNotebookEditor(Option.none());
        yield* vscode.closeNotebook(editor.notebook);
        yield* TestClock.adjust("1 millis");
        yield* vscode.setActiveNotebookEditor(Option.some(reopened));
        yield* TestClock.adjust("1 millis");

        expect(
          yield* commandRanges(vscode, "notebook.cell.collapseCellInput"),
        ).toEqual([[{ start: 0, end: 1 }], [{ start: 0, end: 1 }]]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.scoped(
    "collapses a cell when hide_code changes to true",
    Effect.fn(function* () {
      const { vscode, editor, layer } = yield* withTestCtx([false]);

      yield* Effect.gen(function* () {
        yield* vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("1 millis");
        yield* changeNotebook(vscode, states([false]), states([true]));
        yield* TestClock.adjust("1 millis");

        expect(
          yield* commandRanges(vscode, "notebook.cell.collapseCellInput"),
        ).toEqual([[{ start: 0, end: 1 }]]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.scoped(
    "expands a cell when hide_code changes to false",
    Effect.fn(function* () {
      const { vscode, editor, layer } = yield* withTestCtx([true]);

      yield* Effect.gen(function* () {
        yield* vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("1 millis");
        yield* changeNotebook(vscode, states([true]), states([false]));
        yield* TestClock.adjust("1 millis");

        expect(
          yield* commandRanges(vscode, "notebook.cell.expandCellInput"),
        ).toEqual([[{ start: 0, end: 1 }]]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.scoped(
    "tracks cells by stable ID across structural reordering",
    Effect.fn(function* () {
      const { vscode, editor, layer } = yield* withTestCtx([false, true]);

      yield* Effect.gen(function* () {
        yield* vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("1 millis");
        yield* changeNotebook(vscode, states([false, true]), [
          { stableId: "cell-1", hideCode: true },
          { stableId: "cell-0", hideCode: false },
        ]);
        yield* TestClock.adjust("1 millis");

        expect(
          yield* commandRanges(vscode, "notebook.cell.collapseCellInput"),
        ).toEqual([[{ start: 1, end: 2 }]]);
        expect(
          yield* commandRanges(vscode, "notebook.cell.expandCellInput"),
        ).toEqual([]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.scoped(
    "continues synchronizing after a visibility command defects",
    Effect.fn(function* () {
      const attempts = yield* Ref.make(0);
      const editor = makeEditor(states([false]));
      const vscode = yield* TestVsCode.make({
        initialDocuments: [editor.notebook],
        commands: {
          executeVSCode: () =>
            Ref.updateAndGet(attempts, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.die(new Error("VS Code command rejected"))
                  : Effect.void,
              ),
            ),
        },
      });
      const layer = CellInputVisibilitySyncLive.pipe(
        Layer.provide(vscode.layer),
      );

      yield* Effect.gen(function* () {
        yield* vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("1 millis");
        yield* changeNotebook(vscode, states([false]), states([true]));
        yield* TestClock.adjust("1 millis");
        yield* changeNotebook(vscode, states([true]), states([true]));
        yield* TestClock.adjust("1 millis");

        expect(yield* Ref.get(attempts)).toBe(2);
      }).pipe(Effect.provide(layer));
    }),
  );
});
