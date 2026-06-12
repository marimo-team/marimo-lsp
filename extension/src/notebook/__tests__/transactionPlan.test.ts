import { describe, expect, it } from "@effect/vitest";

import { cellId as cid } from "../../lib/__tests__/branded.ts";
import type { DocumentChange } from "../../types.ts";
import {
  computeDesiredCells,
  diffToReplaceRange,
  type PlanCell,
} from "../transactionPlan.ts";

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

describe("computeDesiredCells", () => {
  it("appends a created cell with no anchor", () => {
    const current = [pc("a", "x = 1"), pc("b", "y = 2")];
    const desired = computeDesiredCells(current, [createCell("c", "z = 3")]);
    expect(ids(desired)).toEqual(["a", "b", "c"]);
  });

  it("inserts a created cell after its anchor", () => {
    const current = [pc("a", "x = 1"), pc("b", "y = 2")];
    const desired = computeDesiredCells(current, [
      createCell("c", "z = 3", { after: "a" }),
    ]);
    expect(ids(desired)).toEqual(["a", "c", "b"]);
  });

  it("folds the create + trailing reorder-cells a code-mode batch emits", () => {
    const current = [pc("a", "x = 1")];
    const desired = computeDesiredCells(current, [
      createCell("c", "z = 3"),
      reorder("a", "c"),
    ]);
    expect(ids(desired)).toEqual(["a", "c"]);
    expect(desired[1].code).toBe("z = 3");
  });

  it("edits code in place", () => {
    const current = [pc("a", "x = 1"), pc("b", "y = 2")];
    const desired = computeDesiredCells(current, [setCode("b", "y = 99")]);
    expect(desired[1]).toMatchObject({ stableId: "b", code: "y = 99" });
  });

  it("deletes a cell", () => {
    const current = [pc("a", "x = 1"), pc("b", "y = 2")];
    const desired = computeDesiredCells(current, [deleteCell("a")]);
    expect(ids(desired)).toEqual(["b"]);
  });

  it("reorders, appending cells missing from the new order", () => {
    const current = [pc("a", "1"), pc("b", "2"), pc("c", "3")];
    const desired = computeDesiredCells(current, [reorder("c", "a")]);
    expect(ids(desired)).toEqual(["c", "a", "b"]);
  });

  it("ignores changes that target an unknown cell", () => {
    const current = [pc("a", "x = 1")];
    const desired = computeDesiredCells(current, [setCode("missing", "nope")]);
    expect(desired).toEqual(current);
  });
});

describe("diffToReplaceRange", () => {
  it("returns null when nothing changed", () => {
    const cells = [pc("a", "x = 1"), pc("b", "y = 2")];
    expect(diffToReplaceRange(cells, [...cells])).toBeNull();
  });

  it("reduces an append to an insert at the end (no existing cell touched)", () => {
    const current = [pc("a", "x = 1"), pc("b", "y = 2")];
    const desired = [...current, pc("c", "z = 3")];
    expect(diffToReplaceRange(current, desired)).toEqual({
      start: 2,
      deleteCount: 0,
      cells: [pc("c", "z = 3")],
    });
  });

  it("narrows an in-place edit to the single changed cell", () => {
    const current = [pc("a", "x = 1"), pc("b", "y = 2"), pc("c", "z = 3")];
    const desired = [pc("a", "x = 1"), pc("b", "y = 99"), pc("c", "z = 3")];
    expect(diffToReplaceRange(current, desired)).toEqual({
      start: 1,
      deleteCount: 1,
      cells: [pc("b", "y = 99")],
    });
  });

  it("narrows a reorder to just the moved span, keeping the stable suffix", () => {
    const current = [pc("a", "1"), pc("b", "2"), pc("c", "3"), pc("d", "4")];
    // Swap the first two; c and d are an unchanged suffix.
    const desired = [pc("b", "2"), pc("a", "1"), pc("c", "3"), pc("d", "4")];
    expect(diffToReplaceRange(current, desired)).toEqual({
      start: 0,
      deleteCount: 2,
      cells: [pc("b", "2"), pc("a", "1")],
    });
  });

  it("replaces the whole range for a rotation with no stable ends", () => {
    const current = [pc("a", "1"), pc("b", "2"), pc("c", "3")];
    const desired = [pc("c", "3"), pc("a", "1"), pc("b", "2")];
    expect(diffToReplaceRange(current, desired)).toEqual({
      start: 0,
      deleteCount: 3,
      cells: desired,
    });
  });
});
