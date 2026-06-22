import type * as vscode from "vscode";

/**
 * A cell output tagged with the stable key of the logical slot it fills.
 *
 * The key is stable across a run's cell-ops, which is what lets the projection
 * edit slots in place instead of rebuilding the list each op. There's one key
 * per console channel and per traceback, plus a `"main"` slot shared by the
 * cell's result, error, or suppressing traceback.
 */
export interface KeyedCellOutput {
  readonly key: string;
  readonly output: vscode.NotebookCellOutput;
}

/**
 * The slice of `vscode.NotebookCellExecution` the projection drives.
 *
 * Narrowed to a port so the projection can be tested against a recording fake;
 * a real `NotebookCellExecution` satisfies it structurally.
 */
export type OutputExecution = Pick<
  vscode.NotebookCellExecution,
  "clearOutput" | "appendOutput" | "replaceOutputItems"
> & {
  readonly cell: Pick<vscode.NotebookCell, "outputs">;
};

/**
 * A slot the projection has emitted and is tracking: the `NotebookCellOutput`
 * VS Code now owns (its identity is what `replaceOutputItems` targets) and the
 * items we last gave it (to skip no-op edits that would re-measure it).
 */
interface TrackedOutput {
  readonly output: vscode.NotebookCellOutput;
  items: readonly vscode.NotebookCellOutputItem[];
}

/**
 * Drives one cell run's outputs onto a `NotebookCellExecution`.
 *
 * Outputs are reconciled incrementally — cleared once on the run's first output,
 * then appended and edited in place as more arrive — the way Jupyter does it,
 * rather than rebuilt from scratch on every cell-op. The stable `"main"` key
 * (see {@link KeyedCellOutput}) turns the common "error box, then traceback
 * supersedes it" transition into an in-place edit.
 *
 * One instance backs one run and holds that run's reconcile state; the next run
 * gets a fresh one.
 */
export class CellOutputProjection {
  readonly #execution: OutputExecution;
  // Tracked slots, in on-screen (insertion) order.
  readonly #tracked = new Map<string, TrackedOutput>();
  // Whether we've cleared the *previous* run's outputs and begun this run's
  // fresh output list. Deferred until the first output arrives.
  #cleared = false;

  constructor(execution: OutputExecution) {
    this.#execution = execution;
  }

  /** Apply a live, incremental update toward `keyed`. */
  async project(keyed: ReadonlyArray<KeyedCellOutput>): Promise<void> {
    await this.#applyIncremental(keyed);
  }

  /**
   * Finish the run: leave the cell showing exactly `keyed`, every output
   * measured.
   *
   * A bare `appendOutput` renders at zero height until something touches it
   * again, so `commit` re-sets each slot's items to force a final measurement.
   * It avoids a full `replaceOutput`, which re-collapses tall outputs and can
   * leave a phantom empty slot when the output set shrank.
   */
  async commit(keyed: ReadonlyArray<KeyedCellOutput>): Promise<void> {
    if (keyed.length === 0) {
      // A run that produced no output must end with none.
      if (this.#execution.cell.outputs.length > 0) await this.#clear();
      return;
    }
    await this.#applyIncremental(keyed);
    await this.#finalize(keyed);
  }

  async #clear(): Promise<void> {
    await this.#execution.clearOutput();
    this.#tracked.clear();
    this.#cleared = true;
  }

  async #applyIncremental(
    keyed: ReadonlyArray<KeyedCellOutput>,
  ): Promise<void> {
    const execution = this.#execution;

    if (keyed.length === 0) {
      // Nothing to show yet. If the previous run left outputs, clear them once;
      // otherwise wait for the first output.
      if (!this.#cleared && execution.cell.outputs.length > 0) {
        await this.#clear();
      }
      return;
    }

    // First output of this run: clear the prior run's outputs so this run's are
    // appended fresh rather than morphed onto stale ones.
    if (!this.#cleared) {
      await this.#clear();
    }

    // A slot we were tracking is gone — VS Code can't remove a single output,
    // so re-clear and re-append from scratch. Uncommon within a single run.
    const desiredKeys = new Set(keyed.map((k) => k.key));
    if ([...this.#tracked.keys()].some((k) => !desiredKeys.has(k))) {
      await this.#clear();
    }

    // Edit tracked slots in place, only when their items actually changed, so
    // unchanged outputs (the traceback) are never re-measured.
    for (const k of keyed) {
      const slot = this.#tracked.get(k.key);
      if (slot && !outputItemsEqual(slot.items, k.output.items)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- ordered edits
        await execution.replaceOutputItems(k.output.items, slot.output);
        slot.items = k.output.items;
      }
    }

    // Append genuinely-new slots at the end, in arrival order. Sequential by
    // design — `appendOutput` appends at the tail, so await order is on-screen
    // order.
    for (const k of keyed) {
      if (this.#tracked.has(k.key)) continue;
      // oxlint-disable-next-line eslint/no-await-in-loop -- ordered appends
      await execution.appendOutput(k.output);
      this.#tracked.set(k.key, { output: k.output, items: k.output.items });
    }
  }

  async #finalize(keyed: ReadonlyArray<KeyedCellOutput>): Promise<void> {
    const execution = this.#execution;
    const canonicalOrder =
      [...this.#tracked.keys()].join(" ") === keyed.map((k) => k.key).join(" ");

    if (!canonicalOrder) {
      // Marimo can deliver cell-ops out of order (e.g. the error before the
      // stdout that preceded it), so the appended order may not match. Rebuild
      // from a clean slate; clearing first avoids a phantom leftover slot.
      await execution.clearOutput();
      this.#tracked.clear();
      for (const k of keyed) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- ordered re-append
        await execution.appendOutput(k.output);
        this.#tracked.set(k.key, { output: k.output, items: k.output.items });
      }
    }

    // Re-set each slot's items in place to force the webview to (re)measure it.
    for (const [, slot] of this.#tracked) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- ordered re-measure
      await execution.replaceOutputItems(slot.items, slot.output);
    }
  }
}

/** Structural equality for two output-item lists (mime + raw bytes). */
function outputItemsEqual(
  a: readonly vscode.NotebookCellOutputItem[],
  b: readonly vscode.NotebookCellOutputItem[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.mime !== y.mime) return false;
    if (x.data.length !== y.data.length) return false;
    for (let j = 0; j < x.data.length; j++) {
      if (x.data[j] !== y.data[j]) return false;
    }
  }
  return true;
}
