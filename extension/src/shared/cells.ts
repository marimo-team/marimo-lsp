// @ts-expect-error
import { transitionCell as untypedTransitionCell } from "@marimo-team/frontend/unstable_internal/core/cells/cell.ts?nocheck";
import type { CellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import type { CellMessage } from "../types.ts";

export type { CellRuntimeState };

/* Type-safe wrapper around marimo's `transitionCell` we import above */
function transitionCell(
  cell: CellRuntimeState,
  message: CellMessage,
): CellRuntimeState {
  return untypedTransitionCell(cell, message);
}

/**
 * Manages cell runtime state for the marimo notebook renderer.
 * This class maintains the state of all cells and applies state transitions
 * based on incoming cell operation messages.
 */
export class CellStateManager {
  #states = new Map<string, CellRuntimeState>();

  /**
   * Handle a cell operation message and update the cell's state.
   * @param message The cell operation message from the kernel
   * @returns The updated cell runtime state
   */
  handleCellOp(message: CellMessage): CellRuntimeState {
    const cellId = message.cell_id;
    const currentState = this.#states.get(cellId) ?? createCellRuntimeState();
    const nextState = transitionCell(currentState, message);
    this.#states.set(cellId, nextState);
    return nextState;
  }
}
