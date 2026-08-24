import { describe, expect, it } from "@effect/vitest";
import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import { Effect, Fiber, Option } from "effect";
import type * as vscode from "vscode";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { runId } from "../../lib/__tests__/branded.ts";
import { VsCode } from "../../platform/VsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
  NotebookCellId,
} from "../../schemas/MarimoNotebookDocument.ts";
import type {
  CellOperationNotification,
  CellRuntimeState,
} from "../../types.ts";
import { CellCommand, transitionCell } from "../CellRunReducer.ts";
import { VsCodeCellPresentation } from "../VsCodeCellPresentation.ts";

const errorState = (): CellRuntimeState => ({
  ...createCellRuntimeState(),
  output: {
    channel: "marimo-error",
    mimetype: "application/vnd.marimo+error",
    data: [{ type: "syntax", msg: "invalid syntax" }],
    timestamp: 0,
  },
});

interface RecordingExecutionOptions {
  readonly fail?: "start" | "replace";
  readonly replace?: () => Thenable<void>;
}

class RecordingExecution implements vscode.NotebookCellExecution {
  readonly cell: vscode.NotebookCell;
  readonly events: string[] = [];
  readonly outputs: vscode.NotebookCellOutput[][] = [];
  readonly options: RecordingExecutionOptions;
  #started = false;
  executionOrder: number | undefined;
  readonly token: vscode.CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} }),
  };

  constructor(
    cell: vscode.NotebookCell,
    options: RecordingExecutionOptions = {},
  ) {
    this.cell = cell;
    this.options = options;
  }

  start(): void {
    this.events.push("start");
    if (this.options.fail === "start") throw new Error("start failed");
    this.#started = true;
  }

  end(success?: boolean): void {
    this.events.push(`end:${String(success)}`);
  }

  replaceOutput(
    outputs:
      | vscode.NotebookCellOutput
      | ReadonlyArray<vscode.NotebookCellOutput>,
  ): Thenable<void> {
    this.requireStarted();
    this.events.push("replace");
    if (this.options.fail === "replace") {
      return Promise.reject(new Error("replace failed"));
    }
    this.outputs.push(Array.isArray(outputs) ? [...outputs] : [outputs]);
    return this.options.replace?.() ?? Promise.resolve();
  }

  appendOutput(): Thenable<void> {
    this.requireStarted();
    this.events.push("append");
    return Promise.resolve();
  }

  replaceOutputItems(): Thenable<void> {
    this.requireStarted();
    this.events.push("replace-items");
    return Promise.resolve();
  }

  appendOutputItems(): Thenable<void> {
    return Promise.resolve();
  }

  clearOutput(): Thenable<void> {
    this.requireStarted();
    this.events.push("clear");
    return Promise.resolve();
  }

  private requireStarted() {
    if (!this.#started) throw new Error("execution has not started");
  }
}

const savedOutput = (staleInputs: boolean): CellOperationNotification => ({
  op: "cell-op",
  cell_id: NotebookCellId("cell-1"),
  output: {
    channel: "output",
    mimetype: "text/html",
    data: "<b>42</b>",
  },
  console: [],
  stale_inputs: staleInputs,
});

const makeNotebook = (outputs: vscode.NotebookCellOutput[] = []) =>
  TestVsCode.makeNotebookEditor("/test/notebook.py", {
    data: {
      cells: [
        {
          kind: 1,
          value: "1 + 1",
          languageId: "python",
          metadata: MarimoNotebookCell.createMetadata({
            marimoRuntime: { stableId: "cell-1" },
          }),
          outputs,
        },
      ],
    },
  });

describe("VsCodeCellPresentation", () => {
  it.effect(
    "defers live output changes until the execution starts",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.make();
      const code = yield* VsCode.pipe(Effect.provide(vscode.layer));
      const editor = makeNotebook([
        new code.NotebookCellOutput([
          code.NotebookCellOutputItem.text("saved"),
        ]),
      ]);
      const notebook = MarimoNotebookDocument.from(editor.notebook);
      const execution = new RecordingExecution(editor.notebook.cellAt(0));
      const id = runId("run-1");
      const cell = {
        notebookId: notebook.id,
        cellId: NotebookCellId("cell-1"),
      };
      const state = transitionCell(
        createCellRuntimeState(),
        savedOutput(false),
      );
      const cellPresentation = yield* VsCodeCellPresentation.make.pipe(
        Effect.provide(vscode.layer),
      );
      const present = cellPresentation.bind({
        notebook,
        controller: { createNotebookCellExecution: () => execution },
      }).present;

      yield* present(cell, CellCommand.OpenRun({ runId: id }));
      yield* present(
        cell,
        CellCommand.RenderOutputs({ runId: id, state, final: false }),
      );
      expect(execution.events).toEqual([]);

      yield* present(
        cell,
        CellCommand.StartRun({ runId: id, at: Option.none() }),
      );
      yield* present(
        cell,
        CellCommand.RenderOutputs({ runId: id, state, final: false }),
      );

      expect(execution.events).toEqual(["start", "clear", "append"]);
    }),
  );

  it.effect(
    "presents an untracked error in one execution lifecycle",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
        data: {
          cells: [
            {
              kind: 1,
              value: "x =",
              languageId: "python",
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "cell-1" },
              }),
            },
          ],
        },
      });
      const code = yield* TestVsCode.make({
        initialDocuments: [editor.notebook],
      });
      const notebook = MarimoNotebookDocument.from(editor.notebook);
      const cellId = Option.getOrThrow(notebook.cellAt(0).id);
      const events: string[] = [];
      const execution: vscode.NotebookCellExecution = {
        cell: editor.notebook.cellAt(0),
        executionOrder: undefined,
        token: {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose() {} }),
        },
        start: () => events.push("start"),
        end: (success) => events.push(`end:${success}`),
        clearOutput: async () => {
          events.push("clear");
        },
        appendOutput: async () => {
          events.push("append");
        },
        replaceOutput: async () => {},
        appendOutputItems: async () => {},
        replaceOutputItems: async () => {
          events.push("finalize");
        },
      };
      const cellPresentation = yield* VsCodeCellPresentation.make.pipe(
        Effect.provide(code.layer),
      );

      yield* cellPresentation
        .bind({
          notebook,
          controller: { createNotebookCellExecution: () => execution },
        })
        .present(
          { notebookId: notebook.id, cellId },
          CellCommand.PresentUntrackedError({
            state: errorState(),
            applyDiagnostic: true,
          }),
        );

      expect(events).toEqual([
        "start",
        "clear",
        "append",
        "finalize",
        "end:false",
      ]);
    }),
  );

  for (const stale of [true, false]) {
    it.effect(
      `presents ${stale ? "cold" : "live"} saved output with marimo's staleness`,
      Effect.fn(function* () {
        const editor = makeNotebook();
        const code = yield* TestVsCode.make({
          initialDocuments: [editor.notebook],
        });
        const notebook = MarimoNotebookDocument.from(editor.notebook);
        let execution: RecordingExecution | undefined;
        const presented: Array<[NotebookCellId, boolean]> = [];

        const cellPresentation = yield* VsCodeCellPresentation.make.pipe(
          Effect.provide(code.layer),
        );
        yield* cellPresentation
          .bind({
            notebook,
            controller: {
              createNotebookCellExecution: (cell) => {
                execution = new RecordingExecution(cell.rawNotebookCell);
                return execution;
              },
            },
          })
          .presentSavedOutputs(
            [savedOutput(stale)],
            editor.notebook.version,
            (notification) =>
              Effect.sync(() =>
                presented.push([
                  NotebookCellId(notification.cell_id),
                  notification.stale_inputs === true,
                ]),
              ),
          );

        expect(presented).toEqual([[NotebookCellId("cell-1"), stale]]);
        expect(execution?.events).toEqual([
          "start",
          "replace",
          "end:undefined",
        ]);

        const richItem = execution?.outputs
          .flat()
          .flatMap((output) => output.items)
          .find((item) => item.mime === "application/vnd.marimo.ui+json");
        expect(richItem).toBeDefined();
        expect(
          JSON.parse(new TextDecoder().decode(richItem?.data)),
        ).toMatchObject({ state: { staleInputs: stale } });
      }),
    );
  }

  it.effect(
    "preserves newer output and rejects a changed document",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.make();
      const code = yield* VsCode.pipe(Effect.provide(vscode.layer));
      const existing = new code.NotebookCellOutput([
        code.NotebookCellOutputItem.text("newer"),
      ]);
      const editor = makeNotebook([existing]);
      const notebook = MarimoNotebookDocument.from(editor.notebook);
      let executions = 0;
      const presented: NotebookCellId[] = [];
      const cellPresentation = yield* VsCodeCellPresentation.make.pipe(
        Effect.provide(vscode.layer),
      );
      const presentation = cellPresentation.bind({
        notebook,
        controller: {
          createNotebookCellExecution: (cell) => {
            executions += 1;
            return new RecordingExecution(cell.rawNotebookCell);
          },
        },
      });

      yield* presentation.presentSavedOutputs(
        [savedOutput(true)],
        editor.notebook.version,
        (notification) =>
          Effect.sync(() =>
            presented.push(NotebookCellId(notification.cell_id)),
          ),
      );
      yield* presentation.presentSavedOutputs(
        [savedOutput(true)],
        editor.notebook.version + 1,
        (notification) =>
          Effect.sync(() =>
            presented.push(NotebookCellId(notification.cell_id)),
          ),
      );

      expect(executions).toBe(0);
      expect(presented).toEqual([NotebookCellId("cell-1")]);
    }),
  );

  for (const failure of ["start", "replace"] as const) {
    it.effect(
      `ends the saved-output execution when ${failure} fails`,
      Effect.fn(function* () {
        const editor = makeNotebook();
        const code = yield* TestVsCode.make();
        const notebook = MarimoNotebookDocument.from(editor.notebook);
        let execution: RecordingExecution | undefined;
        const presented: NotebookCellId[] = [];
        const cellPresentation = yield* VsCodeCellPresentation.make.pipe(
          Effect.provide(code.layer),
        );

        yield* cellPresentation
          .bind({
            notebook,
            controller: {
              createNotebookCellExecution: (cell) => {
                execution = new RecordingExecution(cell.rawNotebookCell, {
                  fail: failure,
                });
                return execution;
              },
            },
          })
          .presentSavedOutputs(
            [savedOutput(true)],
            editor.notebook.version,
            (notification) =>
              Effect.sync(() =>
                presented.push(NotebookCellId(notification.cell_id)),
              ),
          );

        expect(presented).toEqual([]);
        expect(execution?.events).toEqual(
          failure === "start"
            ? ["start", "end:undefined"]
            : ["start", "replace", "end:undefined"],
        );
      }),
    );
  }

  it.effect(
    "adopts a surviving live run when saved display presentation fails",
    Effect.fn(function* () {
      const editor = makeNotebook();
      const code = yield* TestVsCode.make();
      const notebook = MarimoNotebookDocument.from(editor.notebook);
      const presented: NotebookCellId[] = [];
      const cellPresentation = yield* VsCodeCellPresentation.make.pipe(
        Effect.provide(code.layer),
      );

      yield* cellPresentation
        .bind({
          notebook,
          controller: {
            createNotebookCellExecution: (cell) =>
              new RecordingExecution(cell.rawNotebookCell, {
                fail: "replace",
              }),
          },
        })
        .presentSavedOutputs(
          [
            {
              ...savedOutput(false),
              status: "running",
              run_id: "surviving-run",
            },
          ],
          editor.notebook.version,
          (notification) =>
            Effect.sync(() =>
              presented.push(NotebookCellId(notification.cell_id)),
            ),
        );

      expect(presented).toEqual([NotebookCellId("cell-1")]);
    }),
  );

  it.effect(
    "ends and acknowledges a submitted output when interrupted",
    Effect.fn(function* () {
      const editor = makeNotebook();
      const code = yield* TestVsCode.make();
      const notebook = MarimoNotebookDocument.from(editor.notebook);
      let resolveSubmitted: (() => void) | undefined;
      const replaceStarted = new Promise<void>((resolve) => {
        resolveSubmitted = resolve;
      });
      const pending = new Promise<void>(() => undefined);
      let execution: RecordingExecution | undefined;
      const presented: NotebookCellId[] = [];
      const cellPresentation = yield* VsCodeCellPresentation.make.pipe(
        Effect.provide(code.layer),
      );

      const fiber = yield* cellPresentation
        .bind({
          notebook,
          controller: {
            createNotebookCellExecution: (cell) => {
              execution = new RecordingExecution(cell.rawNotebookCell, {
                replace: () => {
                  resolveSubmitted?.();
                  return pending;
                },
              });
              return execution;
            },
          },
        })
        .presentSavedOutputs(
          [savedOutput(true)],
          editor.notebook.version,
          (notification) =>
            Effect.sync(() =>
              presented.push(NotebookCellId(notification.cell_id)),
            ),
        )
        .pipe(Effect.forkChild);

      yield* Effect.promise(() => replaceStarted);
      yield* Fiber.interrupt(fiber);

      expect(presented).toEqual([NotebookCellId("cell-1")]);
      expect(execution?.outputs).toHaveLength(1);
      expect(execution?.events).toEqual(["start", "replace", "end:undefined"]);
    }),
  );
});
