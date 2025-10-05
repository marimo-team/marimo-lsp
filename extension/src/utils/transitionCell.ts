// @ts-expect-error
import { transitionCell as untypedTransitionCell } from "@marimo-team/frontend/unstable_internal/core/cells/cell.ts?nocheck";
import type { CellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import type { CellMessage } from "../types.ts";

export { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
export type { CellRuntimeState };

/* Type-safe wrapper around marimo's `transitionCell` we import above */
export function transitionCell(
  cell: CellRuntimeState,
  message: CellMessage,
): CellRuntimeState {
  return untypedTransitionCell(cell, message);
}
