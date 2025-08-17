import {
  type CellMessage,
  type CellRuntimeState,
  createCellRuntimeState,
  transitionCell,
} from "./marimo-frontend.ts";

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

  /**
   * Get the current state of a cell.
   * @param cellId The ID of the cell
   * @returns The cell's runtime state, or undefined if not found
   */
  getState(cellId: string): CellRuntimeState | undefined {
    return this.#states.get(cellId);
  }

  /**
   * Initialize state for a cell if it doesn't exist.
   * @param cellId The ID of the cell to initialize
   */
  initializeCell(cellId: string): void {
    if (!this.#states.has(cellId)) {
      this.#states.set(cellId, createCellRuntimeState());
    }
  }

  /**
   * Clear the state for a specific cell.
   * @param cellId The ID of the cell to clear
   */
  clearCell(cellId: string): void {
    this.#states.delete(cellId);
  }

  /**
   * Clear all cell states.
   */
  clearAll(): void {
    this.#states.clear();
  }
}
