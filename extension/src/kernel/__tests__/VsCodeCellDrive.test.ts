import { describe, expect, it } from "@effect/vitest";
import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import { Effect, Option } from "effect";
import type * as vscode from "vscode";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../../schemas/MarimoNotebookDocument.ts";
import type { CellRuntimeState } from "../../types.ts";
import { CellCommand, runIdFromWire } from "../CellRunReducer.ts";
import { VsCodeCellDrive } from "../VsCodeCellDrive.ts";

const errorState = (): CellRuntimeState => ({
  ...createCellRuntimeState(),
  output: {
    channel: "marimo-error",
    mimetype: "application/vnd.marimo+error",
    data: [{ type: "syntax", msg: "invalid syntax" }],
    timestamp: 0,
  },
});

describe("VsCodeCellDrive", () => {
  it.effect(
    "does not update outputs before the execution starts",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
        data: {
          cells: [
            {
              kind: 1,
              value: "x = 1",
              languageId: "python",
              outputs: [
                {
                  items: [
                    {
                      mime: "text/plain",
                      data: new TextEncoder().encode("saved"),
                    },
                  ],
                },
              ],
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
      const runId = Option.getOrThrow(runIdFromWire("run-1"));
      const events: string[] = [];
      const execution: vscode.NotebookCellExecution = {
        cell: editor.notebook.cellAt(0),
        executionOrder: undefined,
        token: {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose() {} }),
        },
        start: () => events.push("start"),
        end: () => {},
        clearOutput: async () => {
          events.push("clear");
        },
        appendOutput: async () => {
          events.push("append");
        },
        replaceOutput: async () => {},
        appendOutputItems: async () => {},
        replaceOutputItems: async () => {},
      };
      const drive = (yield* VsCodeCellDrive.make.pipe(
        Effect.provide(code.layer),
      )).bind({
        notebook,
        controller: { createNotebookCellExecution: () => execution },
      });
      const cell = { notebookId: notebook.id, cellId };

      yield* drive(cell, CellCommand.OpenRun({ runId }));
      yield* drive(
        cell,
        CellCommand.RenderOutputs({
          runId,
          state: errorState(),
          final: false,
        }),
      );
      expect(events).toEqual([]);

      yield* drive(cell, CellCommand.StartRun({ runId, at: Option.none() }));
      yield* drive(
        cell,
        CellCommand.RenderOutputs({
          runId,
          state: errorState(),
          final: false,
        }),
      );
      expect(events).toEqual(["start", "clear", "append"]);
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
      const cellDrive = yield* VsCodeCellDrive.make.pipe(
        Effect.provide(code.layer),
      );

      yield* cellDrive.bind({
        notebook,
        controller: { createNotebookCellExecution: () => execution },
      })(
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
});
