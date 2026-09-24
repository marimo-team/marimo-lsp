import * as Vitest from "@effect/vitest";
import { Effect } from "effect";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import * as CellInputVisibilitySync from "../CellInputVisibilitySync.ts";
import * as TestCellInputVisibilitySync from "./TestCellInputVisibilitySync.ts";

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

Vitest.describe("CellInputVisibilitySync", () => {
  const it = EffectTest.make(TestCellInputVisibilitySync.layer);

  it.effect(
    "collapses hide_code cells when a notebook first becomes active",
    Effect.fn(function* () {
      const sync = yield* TestCellInputVisibilitySync.Service;
      const editor = TestCellInputVisibilitySync.makeEditor(
        TestCellInputVisibilitySync.states([false, true, true]),
      );
      yield* sync.activate(editor);
      Vitest.expect(yield* sync.collapsed(editor)).toEqual([
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
      const sync = yield* TestCellInputVisibilitySync.Service;
      const editor = TestCellInputVisibilitySync.makeEditor([
        { stableId: "code", hideCode: true },
        { stableId: "markdown", hideCode: true, kind: 1 },
      ]);
      yield* sync.activate(editor);
      Vitest.expect(yield* sync.collapsed(editor)).toEqual([
        [{ start: 0, end: 1 }],
      ]);
      Vitest.expect(yield* sync.expanded(editor)).toEqual([
        [{ start: 1, end: 2 }],
      ]);
    }),
  );

  it.effect(
    "re-expands markup cells whenever the notebook becomes active",
    Effect.fn(function* () {
      const sync = yield* TestCellInputVisibilitySync.Service;
      const editor = TestCellInputVisibilitySync.makeEditor([
        { stableId: "markdown", hideCode: true, kind: 1 },
      ]);
      yield* sync.activate(editor);
      yield* sync.deactivate;
      yield* sync.activate(editor);
      Vitest.expect(yield* sync.expanded(editor)).toEqual([
        [{ start: 0, end: 1 }],
        [{ start: 0, end: 1 }],
      ]);
    }),
  );

  it.effect(
    "collapses once and does not re-collapse on tab refocus",
    Effect.fn(function* () {
      const sync = yield* TestCellInputVisibilitySync.Service;
      const editor = TestCellInputVisibilitySync.makeEditor(
        TestCellInputVisibilitySync.states([true]),
      );
      yield* sync.activate(editor);
      yield* sync.deactivate;
      yield* sync.activate(editor);
      Vitest.expect(yield* sync.collapsed(editor)).toEqual([
        [{ start: 0, end: 1 }],
      ]);
    }),
  );

  it.effect(
    "collapses hidden cells again after the notebook is closed and reopened",
    Effect.fn(function* () {
      const sync = yield* TestCellInputVisibilitySync.Service;
      const editor = TestCellInputVisibilitySync.makeEditor(
        TestCellInputVisibilitySync.states([true]),
      );
      const reopened = TestCellInputVisibilitySync.makeEditor(
        TestCellInputVisibilitySync.states([true]),
      );
      yield* sync.activate(editor);
      yield* sync.deactivate;
      yield* sync.close(editor.notebook);
      yield* sync.activate(reopened);
      Vitest.expect(yield* sync.collapsed(editor)).toEqual([
        [{ start: 0, end: 1 }],
        [{ start: 0, end: 1 }],
      ]);
    }),
  );

  it.effect(
    "collapses a cell when hide_code changes to true",
    Effect.fn(function* () {
      const sync = yield* TestCellInputVisibilitySync.Service;
      const editor = TestCellInputVisibilitySync.makeEditor(
        TestCellInputVisibilitySync.states([false]),
      );
      yield* sync.activate(editor);
      yield* sync.change(editor, TestCellInputVisibilitySync.states([true]));
      Vitest.expect(yield* sync.collapsed(editor)).toEqual([
        [{ start: 0, end: 1 }],
      ]);
    }),
  );

  it.effect(
    "expands a cell when hide_code changes to false",
    Effect.fn(function* () {
      const sync = yield* TestCellInputVisibilitySync.Service;
      const editor = TestCellInputVisibilitySync.makeEditor(
        TestCellInputVisibilitySync.states([true]),
      );
      yield* sync.activate(editor);
      yield* sync.change(editor, TestCellInputVisibilitySync.states([false]));
      Vitest.expect(yield* sync.expanded(editor)).toEqual([
        [{ start: 0, end: 1 }],
      ]);
    }),
  );

  it.effect(
    "tracks cells by stable ID across structural reordering",
    Effect.fn(function* () {
      const sync = yield* TestCellInputVisibilitySync.Service;
      const editor = TestCellInputVisibilitySync.makeEditor(
        TestCellInputVisibilitySync.states([false, true]),
      );
      yield* sync.activate(editor);
      yield* sync.change(editor, [
        { stableId: "cell-1", hideCode: true },
        { stableId: "cell-0", hideCode: false },
      ]);
      Vitest.expect(yield* sync.collapsed(editor)).toEqual([
        [{ start: 1, end: 2 }],
      ]);
      Vitest.expect(yield* sync.expanded(editor)).toEqual([]);
    }),
  );

  it.effect(
    "expands a hidden code cell when it becomes markup",
    Effect.fn(function* () {
      const sync = yield* TestCellInputVisibilitySync.Service;
      const editor = TestCellInputVisibilitySync.makeEditor([
        { stableId: "cell", hideCode: true },
      ]);
      yield* sync.activate(editor);
      yield* sync.change(editor, [
        { stableId: "cell", hideCode: true, kind: 1 },
      ]);
      Vitest.expect(yield* sync.expanded(editor)).toEqual([
        [{ start: 0, end: 1 }],
      ]);
    }),
  );

  Vitest.describe("when a visibility command defects", () => {
    const it = EffectTest.make(
      TestCellInputVisibilitySync.layerWith(
        TestCellInputVisibilitySync.Scenario.DefectFirstCommand(),
      ),
    );

    it.effect(
      "continues synchronizing",
      Effect.fn(function* () {
        const sync = yield* TestCellInputVisibilitySync.Service;
        const editor = TestCellInputVisibilitySync.makeEditor(
          TestCellInputVisibilitySync.states([false]),
        );
        yield* sync.activate(editor);
        yield* sync.change(editor, TestCellInputVisibilitySync.states([true]));
        yield* sync.change(editor, TestCellInputVisibilitySync.states([true]));
        Vitest.expect(yield* sync.attempts).toBe(2);
      }),
    );
  });
});
