import * as Vitest from "@effect/vitest";

import type { LanguageIds } from "../../src/notebook/classifyCellCode.ts";
import {
  changesForEditor,
  computeDesiredCells,
  diffToReplaceRange,
  type PlanCell,
} from "../../src/notebook/transactionPlan.ts";
import type { DocumentChange } from "../../src/types.ts";
import { cellId as cid } from "../lib/branded.ts";

const LANGUAGE_IDS: LanguageIds = {
  Python: "mo-python",
  Sql: "sql",
  Markdown: "markdown",
};

const compute = (
  current: readonly PlanCell[],
  changes: readonly DocumentChange[],
) => computeDesiredCells(current, changes, LANGUAGE_IDS);

function pc(
  stableId: string,
  code: string,
  extra?: Partial<PlanCell>,
): PlanCell {
  return {
    stableId,
    code,
    languageId: "python",
    kind: 2,
    name: "",
    config: { column: null, disabled: false, hide_code: false },
    ...extra,
  };
}

function createCell(
  cellId: string,
  code: string,
  anchor?: { before?: string; after?: string },
): DocumentChange {
  return {
    type: "create-cell",
    cellId: cid(cellId),
    code,
    name: "",
    config: { column: null, disabled: false, hide_code: true },
    before: anchor?.before ? cid(anchor.before) : null,
    after: anchor?.after ? cid(anchor.after) : null,
  };
}

const setCode = (cellId: string, code: string): DocumentChange => ({
  type: "set-code",
  cellId: cid(cellId),
  code,
});

const setConfig = (cellId: string, hideCode: boolean): DocumentChange => ({
  type: "set-config",
  cellId: cid(cellId),
  column: null,
  disabled: false,
  hideCode,
});

const deleteCell = (cellId: string): DocumentChange => ({
  type: "delete-cell",
  cellId: cid(cellId),
});

const reorder = (...cellIds: string[]): DocumentChange => ({
  type: "reorder-cells",
  cellIds: cellIds.map(cid),
});

function ids(cells: readonly PlanCell[]): string[] {
  return cells.map((cell) => cell.stableId);
}

Vitest.describe("computeDesiredCells", () => {
  Vitest.it("appends a created cell with no anchor", () => {
    const current = [pc("a", "x = 1"), pc("b", "y = 2")];
    const desired = compute(current, [createCell("c", "z = 3")]);
    Vitest.expect(ids(desired)).toEqual(["a", "b", "c"]);
  });

  Vitest.it("inserts a created cell after its anchor", () => {
    const current = [pc("a", "x = 1"), pc("b", "y = 2")];
    const desired = compute(current, [
      createCell("c", "z = 3", { after: "a" }),
    ]);
    Vitest.expect(ids(desired)).toEqual(["a", "c", "b"]);
  });

  Vitest.it(
    "folds the create + trailing reorder-cells a code-mode batch emits",
    () => {
      const current = [pc("a", "x = 1")];
      const desired = compute(current, [
        createCell("c", "z = 3"),
        reorder("a", "c"),
      ]);
      Vitest.expect(ids(desired)).toEqual(["a", "c"]);
      Vitest.expect(desired[1].code).toBe("z = 3");
    },
  );

  Vitest.it("edits code in place", () => {
    const current = [pc("a", "x = 1"), pc("b", "y = 2")];
    const desired = compute(current, [setCode("b", "y = 99")]);
    Vitest.expect(desired[1]).toMatchObject({ stableId: "b", code: "y = 99" });
  });

  Vitest.it.each([
    { previous: false, next: true },
    { previous: true, next: false },
  ])(
    "applies a code-mode hide_code transition from $previous to $next",
    ({ previous, next }) => {
      const current = [
        pc("a", "x = 1", {
          config: { column: null, disabled: false, hide_code: previous },
        }),
      ];

      const desired = compute(current, [setConfig("a", next)]);

      Vitest.expect(desired).toEqual([
        pc("a", "x = 1", {
          config: { column: null, disabled: false, hide_code: next },
        }),
      ]);
    },
  );

  Vitest.it("deletes a cell", () => {
    const current = [pc("a", "x = 1"), pc("b", "y = 2")];
    const desired = compute(current, [deleteCell("a")]);
    Vitest.expect(ids(desired)).toEqual(["b"]);
  });

  Vitest.it("reorders, appending cells missing from the new order", () => {
    const current = [pc("a", "1"), pc("b", "2"), pc("c", "3")];
    const desired = compute(current, [reorder("c", "a")]);
    Vitest.expect(ids(desired)).toEqual(["c", "a", "b"]);
  });

  Vitest.it("ignores changes that target an unknown cell", () => {
    const current = [pc("a", "x = 1")];
    const desired = compute(current, [setCode("missing", "nope")]);
    Vitest.expect(desired).toEqual(current);
  });

  Vitest.it("classifies a created mo.md cell as a markdown markup cell", () => {
    const desired = compute([], [createCell("m", 'mo.md(r"""# Hello""")')]);
    Vitest.expect(desired[0]).toMatchObject({
      stableId: "m",
      // Display code, not the Python wrapper.
      code: "# Hello",
      languageId: "markdown",
      // NotebookCellKind.Markup
      kind: 1,
    });
    Vitest.expect(desired[0].sourceProjections?.markdown).toBeDefined();
  });

  Vitest.it("classifies a created mo.sql cell as a sql code cell", () => {
    const desired = compute(
      [],
      [createCell("q", '_df = mo.sql(f"""SELECT 1""")')],
    );
    Vitest.expect(desired[0]).toMatchObject({
      stableId: "q",
      code: "SELECT 1",
      languageId: "sql",
      // NotebookCellKind.Code
      kind: 2,
    });
    Vitest.expect(desired[0].sourceProjections?.sql).toMatchObject({
      dataframeName: "_df",
    });
  });

  Vitest.it(
    "keeps f-string mo.md as a Python cell (can't round-trip interpolation)",
    () => {
      const desired = compute([], [createCell("m", 'mo.md(f"""# {title}""")')]);
      Vitest.expect(desired[0]).toMatchObject({
        languageId: "mo-python",
        kind: 2,
      });
      Vitest.expect(desired[0].sourceProjections).toBeUndefined();
    },
  );

  Vitest.it("retains inactive projections when a cell changes language", () => {
    const sql = {
      dataframeName: "results",
      quotePrefix: "f" as const,
      commentLines: ["-- keep me"],
      showOutput: false,
      engine: "warehouse",
    };
    const current = [
      pc("a", "SELECT 1", {
        languageId: "sql",
        sourceProjections: { markdown: null, sql },
      }),
    ];

    const markdown = compute(current, [setCode("a", 'mo.md(r"""# Hi""")')]);

    Vitest.expect(markdown[0].sourceProjections?.markdown).toBeDefined();
    Vitest.expect(markdown[0].sourceProjections?.sql).toEqual(sql);
  });

  Vitest.it(
    "promotes a python cell to markdown when set-code makes it mo.md",
    () => {
      const current = [pc("a", "x = 1", { languageId: "mo-python" })];
      const desired = compute(current, [setCode("a", 'mo.md(r"""# Hi""")')]);
      Vitest.expect(desired[0]).toMatchObject({
        stableId: "a",
        code: "# Hi",
        languageId: "markdown",
        kind: 1,
      });
      Vitest.expect(desired[0].sourceProjections?.markdown).toBeDefined();
    },
  );

  Vitest.it(
    "demotes a markdown cell back to python when set-code makes it python",
    () => {
      const current = [
        pc("a", "# Hi", {
          languageId: "markdown",
          kind: 1,
          sourceProjections: { markdown: { quotePrefix: "r" }, sql: null },
        }),
      ];
      const desired = compute(current, [setCode("a", "x = 1")]);
      Vitest.expect(desired[0]).toMatchObject({
        stableId: "a",
        code: "x = 1",
        languageId: "mo-python",
        kind: 2,
      });
      Vitest.expect(desired[0].sourceProjections?.markdown).toEqual({
        quotePrefix: "r",
      });
    },
  );
});

Vitest.describe("changesForEditor", () => {
  Vitest.it.each(["frontend", "kernel", "file-watch", "cell-manager"])(
    "drops %s transactions",
    (source) => {
      Vitest.expect(
        changesForEditor([setCode("a", "x = 2"), reorder("b", "a")], source),
      ).toEqual([]);
    },
  );

  Vitest.it("keeps code-mode transactions", () => {
    const changes = [setCode("a", "x = 2"), reorder("b", "a")];
    Vitest.expect(changesForEditor(changes, "code-mode")).toEqual(changes);
  });
});

Vitest.describe("diffToReplaceRange", () => {
  Vitest.it("returns null when nothing changed", () => {
    const cells = [pc("a", "x = 1"), pc("b", "y = 2")];
    Vitest.expect(diffToReplaceRange(cells, [...cells])).toBeNull();
  });

  Vitest.it(
    "reduces an append to an insert at the end (no existing cell touched)",
    () => {
      const current = [pc("a", "x = 1"), pc("b", "y = 2")];
      const desired = [...current, pc("c", "z = 3")];
      Vitest.expect(diffToReplaceRange(current, desired)).toEqual({
        start: 2,
        deleteCount: 0,
        cells: [pc("c", "z = 3")],
      });
    },
  );

  Vitest.it("narrows an in-place edit to the single changed cell", () => {
    const current = [pc("a", "x = 1"), pc("b", "y = 2"), pc("c", "z = 3")];
    const desired = [pc("a", "x = 1"), pc("b", "y = 99"), pc("c", "z = 3")];
    Vitest.expect(diffToReplaceRange(current, desired)).toEqual({
      start: 1,
      deleteCount: 1,
      cells: [pc("b", "y = 99")],
    });
  });

  Vitest.it(
    "narrows a reorder to just the moved span, keeping the stable suffix",
    () => {
      const current = [pc("a", "1"), pc("b", "2"), pc("c", "3"), pc("d", "4")];
      // Swap the first two; c and d are an unchanged suffix.
      const desired = [pc("b", "2"), pc("a", "1"), pc("c", "3"), pc("d", "4")];
      Vitest.expect(diffToReplaceRange(current, desired)).toEqual({
        start: 0,
        deleteCount: 2,
        cells: [pc("b", "2"), pc("a", "1")],
      });
    },
  );

  Vitest.it(
    "replaces the whole range for a rotation with no stable ends",
    () => {
      const current = [pc("a", "1"), pc("b", "2"), pc("c", "3")];
      const desired = [pc("c", "3"), pc("a", "1"), pc("b", "2")];
      Vitest.expect(diffToReplaceRange(current, desired)).toEqual({
        start: 0,
        deleteCount: 3,
        cells: desired,
      });
    },
  );
});
