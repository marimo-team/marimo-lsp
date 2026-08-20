import { describe, expect, it } from "@effect/vitest";
import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import { Effect, Fiber, Layer, Option } from "effect";
import type * as vscode from "vscode";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { VsCode } from "../../platform/VsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
  NotebookCellId,
} from "../../schemas/MarimoNotebookDocument.ts";
import type { SavedCellOutput } from "../../schemas/Models.gen.ts";
import type { CellRuntimeState } from "../../types.ts";
import { CellCommand } from "../CellRunReducer.ts";
import { VsCodeCellPresentation } from "../VsCodeCellPresentation.ts";

interface RecordingExecutionOptions {
  readonly advanceNotebookVersion?: boolean;
  readonly fail?: "start" | "replace";
  readonly replace?: () => Thenable<void>;
}

class RecordingExecution implements vscode.NotebookCellExecution {
  readonly #advanceNotebookVersion: boolean;
  readonly #fail: "start" | "replace" | undefined;
  readonly #replace: (() => Thenable<void>) | undefined;
  readonly cell: vscode.NotebookCell;
  readonly events: string[] = [];
  readonly outputs: vscode.NotebookCellOutput[][] = [];
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
    this.#fail = options.fail;
    this.#replace = options.replace;
    this.#advanceNotebookVersion = options.advanceNotebookVersion ?? false;
  }

  start(): void {
    this.events.push("start");
    if (this.#fail === "start") throw new Error("start failed");
  }

  end(success?: boolean): void {
    this.events.push(`end:${String(success)}`);
    this.advanceVersion(1);
  }

  replaceOutput(
    outputs:
      | vscode.NotebookCellOutput
      | ReadonlyArray<vscode.NotebookCellOutput>,
  ): Thenable<void> {
    this.events.push("replace");
    if (this.#fail === "replace")
      return Promise.reject(new Error("replace failed"));
    this.outputs.push(Array.isArray(outputs) ? [...outputs] : [outputs]);
    this.advanceVersion(2);
    if (this.#replace !== undefined) return this.#replace();
    return Promise.resolve();
  }

  appendOutput(): Thenable<void> {
    return Promise.resolve();
  }

  replaceOutputItems(): Thenable<void> {
    return Promise.resolve();
  }

  appendOutputItems(): Thenable<void> {
    return Promise.resolve();
  }

  clearOutput(): Thenable<void> {
    return Promise.resolve();
  }

  private advanceVersion(by: number) {
    if (!this.#advanceNotebookVersion) return;
    const notebook = this.cell.notebook;
    Reflect.set(notebook, "version", notebook.version + by);
  }
}

const savedOutput: SavedCellOutput = {
  cellId: "cell-1",
  output: {
    channel: "output",
    mimetype: "text/html",
    data: "<b>42</b>",
  },
  console: [],
};

const errorState = (): CellRuntimeState => ({
  ...createCellRuntimeState(),
  output: {
    channel: "marimo-error",
    mimetype: "application/vnd.marimo+error",
    data: [{ type: "syntax", msg: "invalid syntax" }],
    timestamp: 0,
  },
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

describe("VsCodeCellPresentation.present", () => {
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
      const vscode = yield* TestVsCode.make({
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
        end: (success) => events.push(`end:${String(success)}`),
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

      yield* Effect.gen(function* () {
        const presentation = yield* VsCodeCellPresentation;
        yield* presentation
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
      }).pipe(
        Effect.scoped,
        Effect.provide(
          VsCodeCellPresentation.layer.pipe(Layer.provide(vscode.layer)),
        ),
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
});

describe("VsCodeCellPresentation.presentSavedOutputs", () => {
  it.effect(
    "presents saved output as stale and ends without a result",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.make({});
      const editor = makeNotebook();
      const notebook = MarimoNotebookDocument.from(editor.notebook);
      let execution: RecordingExecution | undefined;

      const restored: NotebookCellId[] = [];
      yield* Effect.gen(function* () {
        const presentation = yield* VsCodeCellPresentation;
        yield* presentation
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
            [savedOutput],
            editor.notebook.version,
            (cellId) => Effect.sync(() => restored.push(cellId)),
          );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          VsCodeCellPresentation.layer.pipe(Layer.provide(vscode.layer)),
        ),
      );

      expect(restored).toEqual([NotebookCellId("cell-1")]);
      expect(execution?.events).toEqual(["start", "replace", "end:undefined"]);

      const richItem = execution?.outputs
        .flat()
        .flatMap((output) => output.items)
        .find((item) => item.mime === "application/vnd.marimo.ui+json");
      expect(richItem).toBeDefined();
      expect(
        JSON.parse(new TextDecoder().decode(richItem?.data)),
      ).toMatchObject({ state: { staleInputs: true } });
    }),
  );

  it.effect(
    "skips existing output and rejects a changed document",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.make({});
      const code = yield* Effect.gen(function* () {
        return yield* VsCode;
      }).pipe(Effect.provide(vscode.layer));
      const existing = new code.NotebookCellOutput([
        code.NotebookCellOutputItem.text("newer"),
      ]);
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
        data: {
          cells: [
            {
              kind: 1,
              value: "1 + 1",
              languageId: "python",
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "cell-1" },
              }),
              outputs: [existing],
            },
            {
              kind: 1,
              value: "2 + 2",
              languageId: "python",
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "cell-2" },
              }),
            },
          ],
        },
      });
      const notebook = MarimoNotebookDocument.from(editor.notebook);
      let executions = 0;

      const results: NotebookCellId[][] = [[], []];
      yield* Effect.gen(function* () {
        const adapter = yield* VsCodeCellPresentation;
        const presentation = adapter.bind({
          notebook,
          controller: {
            createNotebookCellExecution: (cell) => {
              executions += 1;
              return new RecordingExecution(cell.rawNotebookCell);
            },
          },
        });
        yield* Effect.forEach(
          [editor.notebook.version, editor.notebook.version + 1].map(
            (version, index) => ({ version, index }),
          ),
          ({ version, index }) =>
            presentation.presentSavedOutputs(
              [savedOutput, { ...savedOutput, cellId: "cell-2" }],
              version,
              (cellId) =>
                Effect.sync(() => {
                  (results[index] ??= []).push(cellId);
                }),
            ),
          { discard: true },
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          VsCodeCellPresentation.layer.pipe(Layer.provide(vscode.layer)),
        ),
      );

      expect(results).toEqual([[NotebookCellId("cell-2")], []]);
      expect(executions).toBe(1);
    }),
  );

  it.effect(
    "continues after its own output changes advance the notebook version",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.make({});
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
        data: {
          cells: ["cell-1", "cell-2"].map((stableId) => ({
            kind: 1,
            value: stableId,
            languageId: "python",
            metadata: MarimoNotebookCell.createMetadata({
              marimoRuntime: { stableId },
            }),
          })),
        },
      });
      const notebook = MarimoNotebookDocument.from(editor.notebook);
      const originalVersion = editor.notebook.version;
      let executions = 0;

      const restored: NotebookCellId[] = [];
      yield* Effect.gen(function* () {
        const adapter = yield* VsCodeCellPresentation;
        yield* adapter
          .bind({
            notebook,
            controller: {
              createNotebookCellExecution: (cell) => {
                executions += 1;
                return new RecordingExecution(cell.rawNotebookCell, {
                  advanceNotebookVersion: true,
                });
              },
            },
          })
          .presentSavedOutputs(
            [savedOutput, { ...savedOutput, cellId: "cell-2" }],
            originalVersion,
            (cellId) => Effect.sync(() => restored.push(cellId)),
          );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          VsCodeCellPresentation.layer.pipe(Layer.provide(vscode.layer)),
        ),
      );

      expect(restored).toEqual([
        NotebookCellId("cell-1"),
        NotebookCellId("cell-2"),
      ]);
      expect(executions).toBe(2);
      expect(editor.notebook.version).toBeGreaterThan(originalVersion);
    }),
  );

  for (const failure of ["start", "replace"] as const) {
    it.effect(
      `ends the synthetic execution when ${failure} fails`,
      Effect.fn(function* () {
        const vscode = yield* TestVsCode.make({});
        const editor = makeNotebook();
        const notebook = MarimoNotebookDocument.from(editor.notebook);
        let execution: RecordingExecution | undefined;

        const restored: NotebookCellId[] = [];
        yield* Effect.gen(function* () {
          const presentation = yield* VsCodeCellPresentation;
          yield* presentation
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
              [savedOutput],
              editor.notebook.version,
              (cellId) => Effect.sync(() => restored.push(cellId)),
            );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            VsCodeCellPresentation.layer.pipe(Layer.provide(vscode.layer)),
          ),
        );

        expect(restored).toEqual([]);
        expect(execution?.events).toEqual(
          failure === "start"
            ? ["start", "end:undefined"]
            : ["start", "replace", "end:undefined"],
        );
      }),
    );
  }

  it.effect(
    "ends the synthetic execution when hydration is interrupted",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.make({});
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
        data: {
          cells: ["cell-1", "cell-2"].map((stableId) => ({
            kind: 1,
            value: stableId,
            languageId: "python",
            metadata: MarimoNotebookCell.createMetadata({
              marimoRuntime: { stableId },
            }),
          })),
        },
      });
      const notebook = MarimoNotebookDocument.from(editor.notebook);
      const executions: RecordingExecution[] = [];
      const restored: NotebookCellId[] = [];
      let markReplaceStarted: (() => void) | undefined;
      const replaceStarted = new Promise<void>((resolve) => {
        markReplaceStarted = resolve;
      });
      const pendingReplace = new Promise<void>(() => undefined);

      yield* Effect.gen(function* () {
        const adapter = yield* VsCodeCellPresentation;
        const presentation = adapter.bind({
          notebook,
          controller: {
            createNotebookCellExecution: (cell) => {
              const execution = new RecordingExecution(
                cell.rawNotebookCell,
                cell.index === 1
                  ? {
                      replace: () => {
                        markReplaceStarted?.();
                        return pendingReplace;
                      },
                    }
                  : {},
              );
              executions.push(execution);
              return execution;
            },
          },
        });
        const hydration = yield* presentation
          .presentSavedOutputs(
            [savedOutput, { ...savedOutput, cellId: "cell-2" }],
            editor.notebook.version,
            (cellId) => Effect.sync(() => restored.push(cellId)),
          )
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => replaceStarted);
        yield* Fiber.interrupt(hydration);

        expect(restored).toEqual([
          NotebookCellId("cell-1"),
          NotebookCellId("cell-2"),
        ]);
        expect(executions[1]?.outputs).toHaveLength(1);
        expect(executions.map((execution) => execution.events)).toEqual([
          ["start", "replace", "end:undefined"],
          ["start", "replace", "end:undefined"],
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          VsCodeCellPresentation.layer.pipe(Layer.provide(vscode.layer)),
        ),
      );
    }),
  );
});
