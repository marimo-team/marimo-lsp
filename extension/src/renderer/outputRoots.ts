import * as ReactDOM from "react-dom/client";

interface OutputRoot {
  readonly element: HTMLElement;
  readonly root: ReactDOM.Root;
}

/**
 * Owns React roots by VS Code output ID.
 *
 * Render cancellation does not imply disposal; roots remain alive until
 * `disposeOutputItem` is called.
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
}
