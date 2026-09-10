import { Effect } from "effect";
import type * as vscode from "vscode";

/** A cell output tagged with the stable key of its logical slot. */
export interface KeyedCellOutput {
  readonly key: string;
  readonly output: vscode.NotebookCellOutput;
}

/** The output operations used by {@link CellOutputProjection}. */
type OutputExecution = Pick<
  vscode.NotebookCellExecution,
  "clearOutput" | "appendOutput" | "replaceOutputItems"
> & {
  readonly cell: Pick<vscode.NotebookCell, "outputs">;
};

/** A logical slot tracked by position; live outputs are read from the cell. */
interface Slot {
  readonly key: string;
  /** `metadata.channel` of the output appended for this slot. */
  readonly channel: unknown;
  /** Whether VS Code has measured this slot since it was appended. */
  measured: boolean;
}

/**
 * Reconciles a cell's logical output slots across executions.
 *
 * Stable slots are updated in place. If their keys or order change, `commit`
 * rebuilds the output list because VS Code cannot remove a single output.
 */
export class CellOutputProjection {
  // Slots in on-screen (insertion) order; index i is `cell.outputs[i]`.
  #slots: Slot[] = [];

  /** Apply a live, incremental update toward `keyed`. */
  project = Effect.fn(
    { self: this },
    function* (
      execution: OutputExecution,
      keyed: ReadonlyArray<KeyedCellOutput>,
    ): Effect.fn.Return<void> {
      // Nothing to show yet: keep whatever is on screen (typically the previous
      // run's output) rather than flashing empty while the run is in flight.
      if (keyed.length === 0) {
        return;
      }

      if (!this.#inSync(execution)) {
        yield* this.#rebuild(execution, keyed);
        return;
      }
      yield* this.#edit(execution, keyed);
      yield* this.#append(execution, keyed);
    },
  );

  /** Finish the run with exactly `keyed` and measure newly appended slots. */
  commit = Effect.fn(
    { self: this },
    function* (
      execution: OutputExecution,
      keyed: ReadonlyArray<KeyedCellOutput>,
    ): Effect.fn.Return<void> {
      if (keyed.length === 0) {
        // A run that produced no output must end with none.
        if (execution.cell.outputs.length > 0) {
          yield* this.#clear(execution);
        }
        return;
      }
      if (this.#inSync(execution) && this.#sameKeys(keyed)) {
        yield* this.#edit(execution, keyed);
      } else {
        // Marimo can deliver cell-ops out of order (e.g. the error before the
        // stdout that preceded it), or the run dropped a slot the last run had.
        // Rebuild from a clean slate; clearing first avoids a phantom slot.
        yield* this.#rebuild(execution, keyed);
      }
      yield* this.#measure(execution);
    },
  );

  /** Whether the live outputs still match the tracked slot positions. */
  #inSync(execution: OutputExecution): boolean {
    const outputs = execution.cell.outputs;
    if (outputs.length !== this.#slots.length) return false;
    return this.#slots.every(
      (slot, i) => channelOf(outputs[i]) === slot.channel,
    );
  }

  #sameKeys(keyed: ReadonlyArray<KeyedCellOutput>): boolean {
    return (
      this.#slots.length === keyed.length &&
      this.#slots.every((slot, i) => slot.key === keyed[i].key)
    );
  }

  #clear = Effect.fn(
    { self: this },
    function* (execution: OutputExecution): Effect.fn.Return<void> {
      yield* Effect.promise(() => execution.clearOutput());
      this.#slots = [];
    },
  );

  #rebuild = Effect.fn(
    { self: this },
    function* (
      execution: OutputExecution,
      keyed: ReadonlyArray<KeyedCellOutput>,
    ): Effect.fn.Return<void> {
      if (execution.cell.outputs.length > 0) {
        yield* Effect.promise(() => execution.clearOutput());
      }
      this.#slots = [];
      yield* this.#append(execution, keyed);
    },
  );

  /** Edit changed slot items in place; output metadata remains unchanged. */
  #edit = Effect.fn(
    { self: this },
    function* (
      execution: OutputExecution,
      keyed: ReadonlyArray<KeyedCellOutput>,
    ): Effect.fn.Return<void> {
      for (const k of keyed) {
        const index = this.#slots.findIndex((slot) => slot.key === k.key);
        if (index === -1) continue;
        const current = execution.cell.outputs[index];
        if (outputItemsEqual(current.items, k.output.items)) {
          continue;
        }
        yield* Effect.promise(() =>
          execution.replaceOutputItems(k.output.items, current),
        );
        this.#slots[index].measured = true;
      }
    },
  );

  /** Append new slots sequentially to preserve their display order. */
  #append = Effect.fn(
    { self: this },
    function* (
      execution: OutputExecution,
      keyed: ReadonlyArray<KeyedCellOutput>,
    ): Effect.fn.Return<void> {
      for (const k of keyed) {
        if (this.#slots.some((slot) => slot.key === k.key)) continue;
        // oxlint-disable-next-line eslint/no-await-in-loop -- ordered appends
        yield* Effect.promise(() => execution.appendOutput(k.output));
        this.#slots.push({
          key: k.key,
          channel: channelOf(k.output),
          measured: false,
        });
      }
    },
  );

  /** Re-set unmeasured slots' items in place to force the webview to measure. */
  #measure = Effect.fn(
    { self: this },
    function* (execution: OutputExecution): Effect.fn.Return<void> {
      for (const [index, slot] of this.#slots.entries()) {
        if (slot.measured) continue;
        const current = execution.cell.outputs[index];
        // Not mirrored back yet: leave it; the next sync check will rebuild.
        if (current === undefined) {
          continue;
        }
        yield* Effect.promise(() =>
          execution.replaceOutputItems(current.items, current),
        );
        slot.measured = true;
      }
    },
  );
}

function channelOf(output: vscode.NotebookCellOutput): unknown {
  return output.metadata?.channel;
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
