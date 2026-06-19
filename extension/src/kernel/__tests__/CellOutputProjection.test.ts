import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type * as vscode from "vscode";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { VsCode } from "../../platform/VsCode.ts";
import {
  CellOutputProjection,
  type KeyedCellOutput,
  type OutputExecution,
} from "../CellOutputProjection.ts";

const decoder = new TextDecoder();
const decode = (o: vscode.NotebookCellOutput) =>
  o.items.map((i) => decoder.decode(i.data)).join("|");

/** Records the projection's calls; mirrors `cell.outputs` like VS Code does. */
class FakeExecution implements OutputExecution {
  readonly #outputs: vscode.NotebookCellOutput[] = [];
  readonly log: string[] = [];
  readonly cell = { outputs: this.#outputs };

  constructor(initial: ReadonlyArray<vscode.NotebookCellOutput> = []) {
    this.#outputs.push(...initial);
  }
  clearOutput(): Thenable<void> {
    this.log.push("clear");
    this.#outputs.length = 0;
    return Promise.resolve();
  }
  appendOutput(output: vscode.NotebookCellOutput): Thenable<void> {
    this.log.push(`append(${decode(output)})`);
    this.#outputs.push(output);
    return Promise.resolve();
  }
  replaceOutputItems(
    items: ReadonlyArray<vscode.NotebookCellOutputItem>,
    _output: vscode.NotebookCellOutput,
  ): Thenable<void> {
    this.log.push(
      `replace(${items.map((i) => decoder.decode(i.data)).join("|")})`,
    );
    return Promise.resolve();
  }
}

/** Keyed-output builders bound to the test's VS Code value constructors. */
const builders = (code: VsCode) => ({
  stdout: (text: string): KeyedCellOutput => ({
    key: "stdout",
    output: new code.NotebookCellOutput([
      code.NotebookCellOutputItem.stdout(text),
    ]),
  }),
  main: (text: string): KeyedCellOutput => ({
    key: "main",
    output: new code.NotebookCellOutput([
      code.NotebookCellOutputItem.stderr(text),
    ]),
  }),
});

describe("CellOutputProjection", () => {
  it.effect(
    "clears once on first output, then appends; commit re-measures each slot",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.make({});
      yield* Effect.gen(function* () {
        const { stdout, main } = builders(yield* VsCode);
        const exec = new FakeExecution();
        const p = new CellOutputProjection(exec);

        yield* Effect.promise(() => p.project([stdout("10")]));
        yield* Effect.promise(() => p.project([stdout("10"), main("trace")]));
        yield* Effect.promise(() => p.commit([stdout("10"), main("trace")]));

        expect(exec.log).toEqual([
          "clear",
          "append(10)",
          // stdout unchanged → skipped; only the new slot appends
          "append(trace)",
          // commit touches every slot to force a height measurement
          "replace(10)",
          "replace(trace)",
        ]);
      }).pipe(Effect.provide(vscode.layer));
    }),
  );

  it.effect(
    "clears a previous run's outputs on this run's first output",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.make({});
      yield* Effect.gen(function* () {
        const { stdout } = builders(yield* VsCode);
        const exec = new FakeExecution([stdout("stale").output]);
        const p = new CellOutputProjection(exec);

        yield* Effect.promise(() => p.project([stdout("10")]));

        expect(exec.log).toEqual(["clear", "append(10)"]);
      }).pipe(Effect.provide(vscode.layer));
    }),
  );

  it.effect(
    "only re-emits a slot whose items changed",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.make({});
      yield* Effect.gen(function* () {
        const { stdout } = builders(yield* VsCode);
        const exec = new FakeExecution();
        const p = new CellOutputProjection(exec);

        yield* Effect.promise(() => p.project([stdout("10")]));
        yield* Effect.promise(() => p.project([stdout("10")])); // no-op
        yield* Effect.promise(() => p.project([stdout("10\n20")]));

        expect(exec.log).toEqual(["clear", "append(10)", "replace(10\n20)"]);
      }).pipe(Effect.provide(vscode.layer));
    }),
  );

  it.effect(
    "rebuilds from a clean slate when commit order differs (no phantom)",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.make({});
      yield* Effect.gen(function* () {
        const { stdout, main } = builders(yield* VsCode);
        const exec = new FakeExecution();
        const p = new CellOutputProjection(exec);

        // Arrival order put the error first, then stdout.
        yield* Effect.promise(() => p.project([main("trace")]));
        yield* Effect.promise(() => p.project([main("trace"), stdout("10")]));
        // Canonical order is stdout-first: commit re-clears and re-appends.
        yield* Effect.promise(() => p.commit([stdout("10"), main("trace")]));

        expect(exec.log).toEqual([
          "clear",
          "append(trace)",
          "append(10)",
          // order mismatch → clean rebuild, then measure
          "clear",
          "append(10)",
          "append(trace)",
          "replace(10)",
          "replace(trace)",
        ]);
      }).pipe(Effect.provide(vscode.layer));
    }),
  );
});
