import { Effect, Semaphore } from "effect";
import type * as vscode from "vscode";

import {
  CellOutputOperationError,
  tryCellOutputOperation,
} from "./CellOutputOperation.ts";

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
  readonly #ordering = Semaphore.makeUnsafe(1);

  /** Apply a live, incremental update toward `keyed`. */
  project = Effect.fn("CellOutputProjection.project")(
    { self: this },
    function* (
      this: CellOutputProjection,
      execution: OutputExecution,
      keyed: ReadonlyArray<KeyedCellOutput>,
    ) {
      yield* this.#ordering.withPermit(this.#project(execution, keyed));
    },
  );

  /** Finish the run with exactly `keyed` and measure newly appended slots. */
  commit = Effect.fn("CellOutputProjection.commit")(
    { self: this },
    function* (
      this: CellOutputProjection,
      execution: OutputExecution,
      keyed: ReadonlyArray<KeyedCellOutput>,
    ) {
      yield* this.#ordering.withPermit(this.#commit(execution, keyed));
    },
  );

  /** Adopt outputs installed by replay without replacing them. */
  restore = Effect.fn("CellOutputProjection.restore")(
    { self: this },
    function* (
      this: CellOutputProjection,
      displayed: ReadonlyArray<vscode.NotebookCellOutput>,
      keyed: ReadonlyArray<KeyedCellOutput>,
    ) {
      return yield* this.#ordering.withPermit(
        Effect.sync(() => {
          if (
            displayed.length !== keyed.length ||
            !displayed.every(
              (output, index) =>
                channelOf(output) === channelOf(keyed[index].output),
            )
          ) {
            return false;
          }
          this.#slots = keyed.map(({ key }, index) => ({
            key,
            channel: channelOf(displayed[index]),
            measured: true,
          }));
          return true;
        }),
      );
    },
  );

  #project(execution: OutputExecution, keyed: ReadonlyArray<KeyedCellOutput>) {
    return Effect.gen({ self: this }, function* () {
      // Nothing to show yet: keep whatever is on screen (typically the previous
      // run's output) rather than flashing empty while the run is in flight.
      if (keyed.length === 0) return;

      if (!this.#inSync(execution)) {
        yield* this.#rebuild(execution, keyed);
        return;
      }
      if (!(yield* this.#edit(execution, keyed))) {
        yield* this.#rebuild(execution, keyed);
        return;
      }
      if (!(yield* this.#append(execution, keyed))) {
        yield* this.#rebuild(execution, keyed);
      }
    });
  }

  #commit(execution: OutputExecution, keyed: ReadonlyArray<KeyedCellOutput>) {
    return Effect.gen({ self: this }, function* () {
      if (keyed.length === 0) {
        // A run that produced no output must end with none.
        if (execution.cell.outputs.length > 0) {
          yield* this.#clear(execution);
        } else {
          this.#slots = [];
        }
        return undefined;
      }
      if (this.#inSync(execution) && this.#sameKeys(keyed)) {
        if (!(yield* this.#edit(execution, keyed))) {
          yield* this.#rebuild(execution, keyed);
        }
      } else {
        // Marimo can deliver cell-ops out of order (e.g. the error before the
        // stdout that preceded it), or the run dropped a slot the last run had.
        // Rebuild from a clean slate; clearing first avoids a phantom slot.
        yield* this.#rebuild(execution, keyed);
      }
      if (!(yield* this.#measure(execution))) {
        yield* this.#rebuild(execution, keyed);
        if (!(yield* this.#measure(execution))) {
          return yield* synchronizationFailed();
        }
      }
      return undefined;
    });
  }

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

  #clear(execution: OutputExecution) {
    return Effect.gen({ self: this }, function* () {
      yield* tryCellOutputOperation("clearOutput", () =>
        execution.clearOutput(),
      );
      this.#slots = [];
    });
  }

  #rebuild(execution: OutputExecution, keyed: ReadonlyArray<KeyedCellOutput>) {
    return Effect.gen({ self: this }, function* () {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (execution.cell.outputs.length > 0) {
          yield* tryCellOutputOperation("clearOutput", () =>
            execution.clearOutput(),
          );
        }
        this.#slots = [];
        if (yield* this.#append(execution, keyed)) return undefined;
      }
      return yield* synchronizationFailed();
    });
  }

  /** Edit changed slot items in place; output metadata remains unchanged. */
  #edit(execution: OutputExecution, keyed: ReadonlyArray<KeyedCellOutput>) {
    return Effect.gen({ self: this }, function* () {
      for (const k of keyed) {
        const index = this.#slots.findIndex((slot) => slot.key === k.key);
        if (index === -1) continue;
        if (!this.#inSync(execution)) return false;
        const current = execution.cell.outputs[index];
        if (current === undefined) return false;
        if (outputItemsEqual(current.items, k.output.items)) {
          continue;
        }
        yield* tryCellOutputOperation("replaceOutputItems", () =>
          execution.replaceOutputItems(k.output.items, current),
        );
        if (!this.#inSync(execution)) return false;
        this.#slots[index].measured = true;
      }
      return true;
    });
  }

  /** Append new slots sequentially to preserve their display order. */
  #append(execution: OutputExecution, keyed: ReadonlyArray<KeyedCellOutput>) {
    return Effect.gen({ self: this }, function* () {
      for (const k of keyed) {
        if (this.#slots.some((slot) => slot.key === k.key)) continue;
        if (!this.#inSync(execution)) return false;
        // oxlint-disable-next-line eslint/no-await-in-loop -- ordered appends
        yield* tryCellOutputOperation("appendOutput", () =>
          execution.appendOutput(k.output),
        );
        this.#slots.push({
          key: k.key,
          channel: channelOf(k.output),
          measured: false,
        });
        if (!this.#inSync(execution)) return false;
      }
      return true;
    });
  }

  /** Re-set unmeasured slots' items in place to force the webview to measure. */
  #measure(execution: OutputExecution) {
    return Effect.gen({ self: this }, function* () {
      for (const [index, slot] of this.#slots.entries()) {
        if (slot.measured) continue;
        if (!this.#inSync(execution)) return false;
        const current = execution.cell.outputs[index];
        if (current === undefined) return false;
        yield* tryCellOutputOperation("replaceOutputItems", () =>
          execution.replaceOutputItems(current.items, current),
        );
        if (!this.#inSync(execution)) return false;
        slot.measured = true;
      }
      return true;
    });
  }
}

function synchronizationFailed() {
  return Effect.fail(
    new CellOutputOperationError({
      operation: "synchronize",
      cause: new Error("Cell outputs changed during reconciliation"),
    }),
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
