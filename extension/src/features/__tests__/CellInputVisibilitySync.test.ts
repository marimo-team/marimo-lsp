import * as Vitest from "@effect/vitest";
import { Effect, Layer, Option, Ref } from "effect";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import * as CellInputVisibilitySync from "../CellInputVisibilitySync.ts";

const cell = (index: number, hideCode: boolean, kind: 1 | 2 = 2) =>
  MarimoNotebookCell.from(
    TestVsCode.createNotebookCell(
      TestVsCode.createTestNotebookDocument("/test/notebook_mo.py"),
      {
        kind,
        value: "",
        languageId: kind === 1 ? "markdown" : "python",
        metadata: MarimoNotebookCell.createMetadata({
          marimo: { options: { hide_code: hideCode } },
          marimoRuntime: { stableId: `cell-${index}` },
        }),
      },
      index,
    ),
  );

Vitest.describe("hiddenInputRanges", () => {
  Vitest.it(
    "returns one end-exclusive range per hide_code cell, by index",
    () => {
      const cells = [
        cell(0, false),
        cell(1, true),
        cell(2, false),
        cell(3, true),
      ];
      Vitest.expect(CellInputVisibilitySync.hiddenInputRanges(cells)).toEqual([
        { start: 1, end: 2 },
        { start: 3, end: 4 },
      ]);
    },
  );

  Vitest.it("returns no ranges when no cell hides its code", () => {
    Vitest.expect(
      CellInputVisibilitySync.hiddenInputRanges([cell(0, false)]),
    ).toEqual([]);
  });

  Vitest.it(
    "does not hide native markup cells with persisted hide_code",
    () => {
      Vitest.expect(
        CellInputVisibilitySync.hiddenInputRanges([cell(0, true, 1)]),
      ).toEqual([]);
    },
  );
});

const isCellRange = (x: unknown): x is CellInputVisibilitySync.Range =>
  typeof x === "object" &&
  x !== null &&
  "start" in x &&
  typeof x.start === "number" &&
  "end" in x &&
  typeof x.end === "number";

const collapseRanges = (
  arg: unknown,
): readonly CellInputVisibilitySync.Range[] | undefined =>
  typeof arg === "object" &&
  arg !== null &&
  "ranges" in arg &&
  Array.isArray(arg.ranges) &&
  arg.ranges.every(isCellRange)
    ? arg.ranges
    : undefined;

/** The ranges passed to a cell-input visibility command, in order. */
const commandRanges = Effect.fn(function* (
  vscode: TestVsCode.Interface,
  command: "notebook.cell.collapseCellInput" | "notebook.cell.expandCellInput",
) {
  const { executions } = yield* vscode.snapshot;
  return executions
    .filter((execution) => execution.command === command)
    .map((execution) => collapseRanges(execution.args[0]));
});

interface CellState {
  readonly stableId: string;
  readonly hideCode: boolean;
  readonly kind?: 1 | 2;
}

const makeEditor = (cells: readonly CellState[]) =>
  TestVsCode.makeNotebookEditor("/test/notebook_mo.py", {
    data: {
      cells: cells.map(({ stableId, hideCode: hide_code, kind = 2 }) => ({
        kind,
        value: "",
        languageId: kind === 1 ? "markdown" : "python",
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
  vscode: TestVsCode.Interface,
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
        range: new TestVsCode.NotebookRange(0, before.length),
        removedCells: Array.from(previous.notebook.getCells()),
        addedCells: Array.from(editor.notebook.getCells()),
      },
    ],
  });
};

const layer = CellInputVisibilitySync.layer.pipe(
  Layer.provideMerge(TestVsCode.layer),
);
const it = EffectTest.make(layer);

Vitest.describe("CellInputVisibilitySync", () => {
  it.effect(
    "collapses hide_code cells when a notebook first becomes active",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.Service;
      const editor = makeEditor(states([false, true, true]));
      yield* vscode.openNotebook(editor.notebook);
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      yield* Effect.yieldNow;

      Vitest.expect(
        yield* commandRanges(vscode, "notebook.cell.collapseCellInput"),
      ).toEqual([
        [
          { start: 1, end: 2 },
          { start: 2, end: 3 },
        ],
      ]);
    }),
  );

  it.effect(
    "expands markup cells while collapsing hidden code cells on activation",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.Service;
      const editor = makeEditor([
        { stableId: "code", hideCode: true },
        { stableId: "markdown", hideCode: true, kind: 1 },
      ]);
      yield* vscode.openNotebook(editor.notebook);
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      yield* Effect.yieldNow;

      Vitest.expect(
        yield* commandRanges(vscode, "notebook.cell.collapseCellInput"),
      ).toEqual([[{ start: 0, end: 1 }]]);
      Vitest.expect(
        yield* commandRanges(vscode, "notebook.cell.expandCellInput"),
      ).toEqual([[{ start: 1, end: 2 }]]);
    }),
  );

  it.effect(
    "re-expands markup cells whenever the notebook becomes active",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.Service;
      const editor = makeEditor([
        { stableId: "markdown", hideCode: true, kind: 1 },
      ]);
      yield* vscode.openNotebook(editor.notebook);
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      yield* Effect.yieldNow;
      yield* vscode.setActiveNotebookEditor(Option.none());
      yield* Effect.yieldNow;
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      yield* Effect.yieldNow;

      Vitest.expect(
        yield* commandRanges(vscode, "notebook.cell.expandCellInput"),
      ).toEqual([[{ start: 0, end: 1 }], [{ start: 0, end: 1 }]]);
    }),
  );

  it.effect(
    "collapses once and does not re-collapse on tab refocus",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.Service;
      const editor = makeEditor(states([true]));
      yield* vscode.openNotebook(editor.notebook);
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      yield* Effect.yieldNow;
      yield* vscode.setActiveNotebookEditor(Option.none());
      yield* Effect.yieldNow;
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      yield* Effect.yieldNow;

      Vitest.expect(
        yield* commandRanges(vscode, "notebook.cell.collapseCellInput"),
      ).toEqual([[{ start: 0, end: 1 }]]);
    }),
  );

  it.effect(
    "collapses hidden cells again after the notebook is closed and reopened",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.Service;
      const editor = makeEditor(states([true]));
      const reopened = makeEditor(states([true]));
      yield* vscode.openNotebook(editor.notebook);
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      yield* Effect.yieldNow;
      yield* vscode.setActiveNotebookEditor(Option.none());
      yield* vscode.closeNotebook(editor.notebook);
      yield* Effect.yieldNow;
      yield* vscode.openNotebook(reopened.notebook);
      yield* vscode.setActiveNotebookEditor(Option.some(reopened));
      yield* Effect.yieldNow;

      Vitest.expect(
        yield* commandRanges(vscode, "notebook.cell.collapseCellInput"),
      ).toEqual([[{ start: 0, end: 1 }], [{ start: 0, end: 1 }]]);
    }),
  );

  it.effect(
    "collapses a cell when hide_code changes to true",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.Service;
      const editor = makeEditor(states([false]));
      yield* vscode.openNotebook(editor.notebook);
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      yield* Effect.yieldNow;
      yield* changeNotebook(vscode, states([false]), states([true]));
      yield* Effect.yieldNow;

      Vitest.expect(
        yield* commandRanges(vscode, "notebook.cell.collapseCellInput"),
      ).toEqual([[{ start: 0, end: 1 }]]);
    }),
  );

  it.effect(
    "expands a cell when hide_code changes to false",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.Service;
      const editor = makeEditor(states([true]));
      yield* vscode.openNotebook(editor.notebook);
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      yield* Effect.yieldNow;
      yield* changeNotebook(vscode, states([true]), states([false]));
      yield* Effect.yieldNow;

      Vitest.expect(
        yield* commandRanges(vscode, "notebook.cell.expandCellInput"),
      ).toEqual([[{ start: 0, end: 1 }]]);
    }),
  );

  it.effect(
    "tracks cells by stable ID across structural reordering",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.Service;
      const editor = makeEditor(states([false, true]));
      yield* vscode.openNotebook(editor.notebook);
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      yield* Effect.yieldNow;
      yield* changeNotebook(vscode, states([false, true]), [
        { stableId: "cell-1", hideCode: true },
        { stableId: "cell-0", hideCode: false },
      ]);
      yield* Effect.yieldNow;

      Vitest.expect(
        yield* commandRanges(vscode, "notebook.cell.collapseCellInput"),
      ).toEqual([[{ start: 1, end: 2 }]]);
      Vitest.expect(
        yield* commandRanges(vscode, "notebook.cell.expandCellInput"),
      ).toEqual([]);
    }),
  );

  it.effect(
    "expands a hidden code cell when it becomes markup",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.Service;
      const before = [{ stableId: "cell", hideCode: true }];
      const after = [{ stableId: "cell", hideCode: true, kind: 1 as const }];
      const editor = makeEditor(before);
      yield* vscode.openNotebook(editor.notebook);
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      yield* Effect.yieldNow;
      yield* changeNotebook(vscode, before, after);
      yield* Effect.yieldNow;

      Vitest.expect(
        yield* commandRanges(vscode, "notebook.cell.expandCellInput"),
      ).toEqual([[{ start: 0, end: 1 }]]);
    }),
  );

  Vitest.it.effect(
    "continues synchronizing after a visibility command defects",
    Effect.fn(function* () {
      const attempts = yield* Ref.make(0);
      const editor = makeEditor(states([false]));
      const vscodeLayer = TestVsCode.layerWith({
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
      const defectLayer = CellInputVisibilitySync.layer.pipe(
        Layer.provideMerge(vscodeLayer),
      );

      yield* Effect.gen(function* () {
        const vscode = yield* TestVsCode.Service;
        yield* vscode.openNotebook(editor.notebook);
        yield* vscode.setActiveNotebookEditor(Option.some(editor));
        yield* Effect.yieldNow;
        yield* changeNotebook(vscode, states([false]), states([true]));
        yield* Effect.yieldNow;
        yield* changeNotebook(vscode, states([true]), states([true]));
        yield* Effect.yieldNow;

        Vitest.expect(yield* Ref.get(attempts)).toBe(2);
      }).pipe(Effect.provide(defectLayer));
    }),
  );
});
