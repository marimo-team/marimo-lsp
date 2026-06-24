import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, TestClock } from "effect";

import {
  createNotebookCell,
  createTestNotebookDocument,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import {
  type CellRange,
  hiddenInputCellRanges,
  HideCodeSyncLive,
} from "../HideCodeSync.ts";

const cell = (index: number, hideCode: boolean) =>
  MarimoNotebookCell.from(
    createNotebookCell(
      createTestNotebookDocument("/test/notebook_mo.py"),
      {
        kind: 2,
        value: "",
        languageId: "python",
        metadata: {
          stableId: `cell-${index}`,
          options: { hide_code: hideCode },
        },
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

/** The ranges passed to each `notebook.cell.collapseCellInput` call, in order. */
const collapses = Effect.fn(function* (vscode: TestVsCode) {
  const executions = yield* Ref.get(vscode.executions);
  return executions
    .filter((e) => e.command === "notebook.cell.collapseCellInput")
    .map((e) => collapseRanges(e.args[0]));
});

const withTestCtx = Effect.fn(function* (hideCode: ReadonlyArray<boolean>) {
  const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py", {
    data: {
      cells: hideCode.map((hide_code, index) => ({
        kind: 2,
        value: "",
        languageId: "python",
        metadata: { stableId: `cell-${index}`, options: { hide_code } },
      })),
    },
  });
  const vscode = yield* TestVsCode.make({
    initialDocuments: [editor.notebook],
  });
  const layer = HideCodeSyncLive.pipe(Layer.provide(vscode.layer));
  return { vscode, editor, layer };
});

describe("HideCodeSync", () => {
  it.scoped(
    "collapses hide_code cells when a notebook first becomes active",
    Effect.fn(function* () {
      const { vscode, editor, layer } = yield* withTestCtx([false, true, true]);

      yield* Effect.gen(function* () {
        yield* vscode.setActiveNotebookEditor(Option.some(editor));
        yield* TestClock.adjust("1 millis");

        expect(yield* collapses(vscode)).toEqual([
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

        expect(yield* collapses(vscode)).toEqual([[{ start: 0, end: 1 }]]);
      }).pipe(Effect.provide(layer));
    }),
  );
});
