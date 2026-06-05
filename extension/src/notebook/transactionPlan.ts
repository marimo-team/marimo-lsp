/**
 * Pure translation of a kernel document transaction into a notebook edit plan.
 *
 * Code mode (and any other source) emits a {@link DocumentChange} sequence. To
 * replay it onto the VS Code notebook we (1) fold the changes into the desired
 * cell order/content and (2) diff that against the current cells to find the
 * minimal contiguous range to replace. The replay is keyed by `stableId`, which
 * equals marimo's `CellId` (see ADR 0002), so no content matching is needed —
 * the applier carries each surviving cell's outputs forward by `stableId`.
 *
 * This module is free of `vscode` so the logic is trivially unit-testable; the
 * applier turns a {@link ReplaceRange} into a `NotebookEdit`. `PlanCell` is a
 * `Schema` so its equality is *derived* (`Schema.equivalence`, see
 * {@link cellEquivalence}) rather than hand-written, and the applier can decode
 * VS Code cells into it at the boundary.
 */

import { Schema } from "effect";

import type { CellConfig, DocumentChange } from "../types.ts";

/** NotebookCellKind.Code — kept as a literal so this module stays vscode-free. */
const CODE_KIND = 2;

/** Cell config in one normalized shape (CellConfig's documented defaults applied). */
const PlanCellConfig = Schema.Struct({
  column: Schema.NullOr(Schema.Number),
  disabled: Schema.Boolean,
  hide_code: Schema.Boolean,
});

/** A minimal, `vscode`-free view of a notebook cell for transaction planning. */
const PlanCell = Schema.Struct({
  stableId: Schema.String,
  code: Schema.String,
  languageId: Schema.String,
  /** Matches `vscode.NotebookCellKind`: 1 = Markup, 2 = Code. */
  kind: Schema.Number,
  name: Schema.String,
  config: PlanCellConfig,
});
export type PlanCell = typeof PlanCell.Type;

/**
 * Structural cell equality, derived from the schema. Used to find the stable
 * prefix/suffix so only genuinely-changed cells are replaced.
 */
const cellEquivalence = Schema.equivalence(PlanCell);

/** A minimal contiguous splice: replace `deleteCount` cells at `start` with `cells`. */
export interface ReplaceRange {
  readonly start: number;
  readonly deleteCount: number;
  readonly cells: readonly PlanCell[];
}

/** Apply CellConfig's documented defaults so wire configs land in the normalized shape. */
const normalizeConfig = (config: CellConfig): typeof PlanCellConfig.Type => ({
  column: config.column ?? null,
  disabled: config.disabled ?? false,
  hide_code: config.hide_code ?? false,
});

function indexOfId(cells: readonly PlanCell[], id: string | null | undefined) {
  return id == null ? -1 : cells.findIndex((cell) => cell.stableId === id);
}

/** Resolve where a cell anchored by `before`/`after` lands; appends if neither resolves. */
function insertionIndex(
  cells: readonly PlanCell[],
  before: string | null | undefined,
  after: string | null | undefined,
): number {
  const afterIdx = indexOfId(cells, after);
  if (afterIdx !== -1) return afterIdx + 1;
  const beforeIdx = indexOfId(cells, before);
  if (beforeIdx !== -1) return beforeIdx;
  return cells.length;
}

/**
 * Fold a transaction's changes into the desired cell list. Mirrors marimo's
 * `NotebookDocument.apply` on the VS Code side. Unknown ids in a change are
 * ignored (the change is a no-op), matching the kernel's own tolerance.
 */
export function computeDesiredCells(
  current: readonly PlanCell[],
  changes: readonly DocumentChange[],
): PlanCell[] {
  let cells: PlanCell[] = [...current];

  for (const change of changes) {
    switch (change.type) {
      case "create-cell": {
        const cell: PlanCell = {
          stableId: change.cellId,
          code: change.code,
          // TODO: derive languageId/kind for markdown/sql cells created via
          // code mode; today every committed cell is treated as Python.
          languageId: "python",
          kind: CODE_KIND,
          name: change.name,
          config: normalizeConfig(change.config),
        };
        cells.splice(
          insertionIndex(cells, change.before, change.after),
          0,
          cell,
        );
        break;
      }
      case "delete-cell": {
        const idx = indexOfId(cells, change.cellId);
        if (idx !== -1) cells.splice(idx, 1);
        break;
      }
      case "set-code": {
        const idx = indexOfId(cells, change.cellId);
        if (idx !== -1) cells[idx] = { ...cells[idx], code: change.code };
        break;
      }
      case "set-name": {
        const idx = indexOfId(cells, change.cellId);
        if (idx !== -1) cells[idx] = { ...cells[idx], name: change.name };
        break;
      }
      case "set-config": {
        const idx = indexOfId(cells, change.cellId);
        if (idx !== -1) {
          // SetConfig is camelCase on the wire (`hideCode`); land it in the
          // normalized `hide_code` shape so config compares cleanly.
          cells[idx] = {
            ...cells[idx],
            config: {
              column: change.column,
              disabled: change.disabled,
              hide_code: change.hideCode,
            },
          };
        }
        break;
      }
      case "move-cell": {
        const idx = indexOfId(cells, change.cellId);
        if (idx === -1) break;
        const [cell] = cells.splice(idx, 1);
        cells.splice(
          insertionIndex(cells, change.before, change.after),
          0,
          cell,
        );
        break;
      }
      case "reorder-cells": {
        const remaining = new Map(cells.map((cell) => [cell.stableId, cell]));
        const reordered: PlanCell[] = [];
        for (const id of change.cellIds) {
          const cell = remaining.get(id);
          if (cell) {
            reordered.push(cell);
            remaining.delete(id);
          }
        }
        // Cells present but absent from the new order are appended, in their
        // current relative order (marimo's ReorderCells semantics).
        for (const cell of cells) {
          if (remaining.has(cell.stableId)) reordered.push(cell);
        }
        cells = reordered;
        break;
      }
    }
  }

  return cells;
}

/**
 * Diff the desired cells against the current ones, returning the smallest
 * contiguous range that needs replacing — or `null` when nothing changed (the
 * common case for a no-op `reorder-cells` after an append). Stable prefix and
 * suffix cells keep their identity (and outputs); only the changed middle is
 * replaced.
 */
export function diffToReplaceRange(
  current: readonly PlanCell[],
  desired: readonly PlanCell[],
): ReplaceRange | null {
  const limit = Math.min(current.length, desired.length);

  let prefix = 0;
  while (prefix < limit && cellEquivalence(current[prefix], desired[prefix]))
    prefix++;

  if (current.length === desired.length && prefix === current.length) {
    return null;
  }

  let suffix = 0;
  while (
    suffix < limit - prefix &&
    cellEquivalence(
      current[current.length - 1 - suffix],
      desired[desired.length - 1 - suffix],
    )
  ) {
    suffix++;
  }

  return {
    start: prefix,
    deleteCount: current.length - prefix - suffix,
    cells: desired.slice(prefix, desired.length - suffix),
  };
}
