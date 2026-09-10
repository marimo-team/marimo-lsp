import * as ReactDOM from "react-dom/client";

interface OutputRoot {
  readonly element: HTMLElement;
  readonly root: ReactDOM.Root;
}

/**
 * React roots for rendered output items, keyed by output item id.
 *
 * VS Code calls `renderOutputItem` again on the *same* element every time an
 * output's items change, and aborts the previous call's signal first. That
 * abort means "the previous render was cancelled", not "the output is gone" —
 * treating it as disposal unmounted the whole React tree on every update, so
 * marimo UI elements lost their DOM nodes (and any in-progress pointer
 * interaction) each time a cell re-rendered (#826).
 *
 * Reusing the root per output id lets React reconcile in place. Roots are
 * released only from `disposeOutputItem`, which VS Code calls when the
 * output is actually removed.
 */
export class OutputRoots {
  readonly #roots = new Map<string, OutputRoot>();

  /**
   * Returns the root mounted on `element` for `id`, creating one if needed.
   *
   * If VS Code hands us a different element for an id we already know, the
   * old root is unmounted first: the previous node is gone.
   */
  acquire(id: string, element: HTMLElement): ReactDOM.Root {
    const existing = this.#roots.get(id);
    if (existing?.element === element) return existing.root;
    existing?.root.unmount();
    const root = ReactDOM.createRoot(element);
    this.#roots.set(id, { element, root });
    return root;
  }

  /** Unmounts the root for `id`, or every root when `id` is `undefined`. */
  dispose(id?: string): void {
    if (id === undefined) {
      for (const { root } of this.#roots.values()) root.unmount();
      this.#roots.clear();
      return;
    }
    const existing = this.#roots.get(id);
    if (!existing) return;
    existing.root.unmount();
    this.#roots.delete(id);
  }

  /** Number of live roots; exposed for tests. */
  get size(): number {
    return this.#roots.size;
  }
}
