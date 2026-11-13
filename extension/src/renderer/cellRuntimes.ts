import type { CellId, CellRuntimeState } from "../types.ts";

export class CellRuntimes {
  readonly #cells = new Map<CellId, Map<symbol, CellRuntimeState>>();

  register(
    cellId: CellId,
    runtime: CellRuntimeState,
  ): () => CellRuntimeState | undefined {
    const owner = Symbol();
    let registrations = this.#cells.get(cellId);
    if (!registrations) {
      registrations = new Map();
      this.#cells.set(cellId, registrations);
    }
    registrations.set(owner, runtime);

    return () => {
      const remaining = this.#cells.get(cellId);
      if (!remaining) return undefined;
      remaining.delete(owner);
      if (remaining.size === 0) {
        this.#cells.delete(cellId);
        return undefined;
      }
      return [...remaining.values()].at(-1);
    };
  }
}
