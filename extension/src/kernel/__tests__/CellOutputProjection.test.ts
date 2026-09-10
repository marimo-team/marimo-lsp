import { describe, expect, it } from "@effect/vitest";
import { type Context, Effect } from "effect";
import type * as vscode from "vscode";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { VsCode } from "../../platform/VsCode.ts";
import {
  CellOutputProjection,
  type KeyedCellOutput,
} from "../CellOutputProjection.ts";

type OutputExecution = Parameters<CellOutputProjection["project"]>[0];

const decoder = new TextDecoder();
const decodeItems = (items: ReadonlyArray<vscode.NotebookCellOutputItem>) =>
  items.map((i) => decoder.decode(i.data)).join("|");
const decode = (o: vscode.NotebookCellOutput) => decodeItems(o.items);

/** The cell's outputs, shared by every execution of that cell. */
class FakeCell {
  readonly outputs: vscode.NotebookCellOutput[] = [];
  readonly log: string[] = [];

  constructor(initial: ReadonlyArray<vscode.NotebookCellOutput> = []) {
    this.outputs.push(...initial);
  }

  /** What's on screen, by slot. */
  get shown(): string[] {
    return this.outputs.map(decode);
  }

  /** Drain the recorded calls. */
  take(): string[] {
    return this.log.splice(0);
  }
}

/** Records the projection's calls; mirrors `cell.outputs` like VS Code does. */
class FakeExecution implements OutputExecution {
  readonly cell: FakeCell;

  constructor(cell: FakeCell) {
    this.cell = cell;
  }
  clearOutput(): Thenable<void> {
    this.cell.log.push("clear");
    this.cell.outputs.length = 0;
    return Promise.resolve();
  }
  appendOutput(output: vscode.NotebookCellOutput): Thenable<void> {
    this.cell.log.push(`append(${decode(output)})`);
    this.cell.outputs.push(output);
    return Promise.resolve();
  }
  replaceOutputItems(
    items: ReadonlyArray<vscode.NotebookCellOutputItem>,
    output: vscode.NotebookCellOutput,
  ): Thenable<void> {
    const index = this.cell.outputs.indexOf(output);
    expect(index, "replaceOutputItems must target a live output").not.toBe(-1);
    this.cell.log.push(`replace(${decodeItems(items)})`);
    // VS Code hands back a fresh object for the edited output.
    this.cell.outputs[index] = { items: [...items], metadata: output.metadata };
    return Promise.resolve();
  }
}

/** Keyed-output builders bound to the test's VS Code value constructors. */
const builders = (code: Context.Service.Shape<typeof VsCode>) => ({
  stdout: (text: string): KeyedCellOutput => ({
    key: "stdout",
    output: new code.NotebookCellOutput(
      [code.NotebookCellOutputItem.stdout(text)],
      { channel: "stdout" },
    ),
  }),
  main: (text: string): KeyedCellOutput => ({
    key: "main",
    output: new code.NotebookCellOutput([
      code.NotebookCellOutputItem.stderr(text),
    ]),
  }),
});

const withBuilders = (
  body: (b: ReturnType<typeof builders>) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const vscode = yield* TestVsCode.make({});
    yield* Effect.gen(function* () {
      yield* body(builders(yield* VsCode));
    }).pipe(Effect.provide(vscode.layer));
  });

describe("CellOutputProjection", () => {
  it.effect(
    "appends as outputs arrive; commit measures each appended slot",
    Effect.fn(function* () {
      yield* withBuilders(({ stdout, main }) =>
        Effect.gen(function* () {
          const cell = new FakeCell();
          const exec = new FakeExecution(cell);
          const p = new CellOutputProjection();

          yield* p.project(exec, [stdout("10")]);
          yield* p.project(exec, [stdout("10"), main("trace")]);
          yield* p.commit(exec, [stdout("10"), main("trace")]);

          expect(cell.take()).toEqual([
            "append(10)",
            // stdout unchanged → skipped; only the new slot appends
            "append(trace)",
            // commit touches each bare slot to force a height measurement
            "replace(10)",
            "replace(trace)",
          ]);
          expect(cell.shown).toEqual(["10", "trace"]);
        }),
      );
    }),
  );

  it.effect(
    "only re-emits a slot whose items changed, and does not re-measure it",
    Effect.fn(function* () {
      yield* withBuilders(({ stdout }) =>
        Effect.gen(function* () {
          const cell = new FakeCell();
          const exec = new FakeExecution(cell);
          const p = new CellOutputProjection();

          yield* p.project(exec, [stdout("10")]);
          yield* p.project(exec, [stdout("10")]); // no-op
          yield* p.project(exec, [stdout("10\n20")]);
          yield* p.commit(exec, [stdout("10\n20")]);

          // The in-place edit already measured the slot; commit adds nothing.
          expect(cell.take()).toEqual(["append(10)", "replace(10\n20)"]);
        }),
      );
    }),
  );

  it.effect(
    "rebuilds from a clean slate when commit order differs (no phantom)",
    Effect.fn(function* () {
      yield* withBuilders(({ stdout, main }) =>
        Effect.gen(function* () {
          const cell = new FakeCell();
          const exec = new FakeExecution(cell);
          const p = new CellOutputProjection();

          // Arrival order put the error first, then stdout.
          yield* p.project(exec, [main("trace")]);
          yield* p.project(exec, [main("trace"), stdout("10")]);
          // Canonical order is stdout-first: commit re-clears and re-appends.
          yield* p.commit(exec, [stdout("10"), main("trace")]);

          expect(cell.take()).toEqual([
            "append(trace)",
            "append(10)",
            // order mismatch → clean rebuild, then measure
            "clear",
            "append(10)",
            "append(trace)",
            "replace(10)",
            "replace(trace)",
          ]);
          expect(cell.shown).toEqual(["10", "trace"]);
        }),
      );
    }),
  );

  it.effect(
    "a re-run edits the previous run's outputs in place",
    Effect.fn(function* () {
      yield* withBuilders(({ stdout, main }) =>
        Effect.gen(function* () {
          const cell = new FakeCell();
          const p = new CellOutputProjection();

          const first = new FakeExecution(cell);
          yield* p.project(first, [stdout("10"), main("v1")]);
          yield* p.commit(first, [stdout("10"), main("v1")]);
          cell.take();

          // The next run gets its own execution but the same cell projection.
          const second = new FakeExecution(cell);
          // Queued/running with nothing new yet: the previous output stays.
          yield* p.project(second, []);
          expect(cell.take()).toEqual([]);
          expect(cell.shown).toEqual(["10", "v1"]);

          yield* p.project(second, [stdout("10"), main("v2")]);
          yield* p.commit(second, [stdout("10"), main("v2")]);

          // No clear, no append: the on-screen outputs keep their identity.
          expect(cell.take()).toEqual(["replace(v2)"]);
          expect(cell.shown).toEqual(["10", "v2"]);
        }),
      );
    }),
  );

  it.effect(
    "a re-run that drops a slot rebuilds only at commit",
    Effect.fn(function* () {
      yield* withBuilders(({ stdout, main }) =>
        Effect.gen(function* () {
          const cell = new FakeCell();
          const p = new CellOutputProjection();

          const first = new FakeExecution(cell);
          yield* p.commit(first, [stdout("10"), main("v1")]);
          cell.take();

          // This run never prints. Its result lands in place while the stale
          // stdout lingers; VS Code can't drop one output, so commit rebuilds.
          const second = new FakeExecution(cell);
          yield* p.project(second, [main("v2")]);
          expect(cell.take()).toEqual(["replace(v2)"]);
          expect(cell.shown).toEqual(["10", "v2"]);

          yield* p.commit(second, [main("v2")]);
          expect(cell.take()).toEqual(["clear", "append(v2)", "replace(v2)"]);
          expect(cell.shown).toEqual(["v2"]);
        }),
      );
    }),
  );

  it.effect(
    "rebuilds when something else rewrote the cell's outputs",
    Effect.fn(function* () {
      yield* withBuilders(({ stdout, main }) =>
        Effect.gen(function* () {
          const cell = new FakeCell();
          const p = new CellOutputProjection();
          yield* p.commit(new FakeExecution(cell), [main("v1")]);
          cell.take();

          // "Clear All Outputs" emptied the cell behind our back.
          cell.outputs.length = 0;
          yield* p.project(new FakeExecution(cell), [main("v2")]);
          expect(cell.take()).toEqual(["append(v2)"]);

          // Same count, but not the slot we appended.
          cell.outputs[0] = stdout("other").output;
          yield* p.project(new FakeExecution(cell), [main("v3")]);
          expect(cell.take()).toEqual(["clear", "append(v3)"]);
          expect(cell.shown).toEqual(["v3"]);
        }),
      );
    }),
  );

  it.effect(
    "a run with no output ends with none",
    Effect.fn(function* () {
      yield* withBuilders(({ main }) =>
        Effect.gen(function* () {
          const cell = new FakeCell();
          const p = new CellOutputProjection();
          yield* p.commit(new FakeExecution(cell), [main("v1")]);
          cell.take();

          const second = new FakeExecution(cell);
          yield* p.project(second, []);
          yield* p.commit(second, []);
          expect(cell.take()).toEqual(["clear"]);
          expect(cell.shown).toEqual([]);

          // And a later empty commit on an empty cell is a no-op.
          yield* p.commit(new FakeExecution(cell), []);
          expect(cell.take()).toEqual([]);
        }),
      );
    }),
  );
});
