import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type * as vscode from "vscode";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
  NotebookCellId,
} from "../../schemas/MarimoNotebookDocument.ts";
import type { CellOutputReplay } from "../../schemas/Models.gen.ts";
import { VsCodeNotebookOutputPresenter } from "../VsCodeNotebookOutputPresenter.ts";

const savedReplay: CellOutputReplay = {
  kind: "saved",
  notification: {
    op: "cell-op",
    cell_id: NotebookCellId("cell-1"),
    status: "idle",
    output: {
      channel: "output",
      mimetype: "text/html",
      data: "<b>42</b>",
    },
    stale_inputs: true,
  },
};

const editor = (outputs: vscode.NotebookCellOutput[] = []) =>
  TestVsCode.makeNotebookEditor("/test/notebook.py", {
    data: {
      cells: [
        {
          kind: 2,
          value: "1 + 1",
          languageId: "python",
          outputs,
          metadata: MarimoNotebookCell.createMetadata({
            marimoRuntime: { stableId: "cell-1" },
          }),
        },
      ],
    },
  });

it.effect(
  "presents saved output without completing a run",
  Effect.fn(function* () {
    const notebookEditor = editor();
    const code = yield* TestVsCode.make({
      initialDocuments: [notebookEditor.notebook],
    });
    const events: string[] = [];
    const rendered: vscode.NotebookCellOutput[][] = [];
    const execution: vscode.NotebookCellExecution = {
      cell: notebookEditor.notebook.cellAt(0),
      executionOrder: undefined,
      token: {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose() {} }),
      },
      start: () => events.push("start"),
      end: (success) => events.push(`end:${String(success)}`),
      replaceOutput: async (outputs) => {
        events.push("replace");
        rendered.push(Array.isArray(outputs) ? [...outputs] : [outputs]);
      },
      appendOutput: async () => {},
      clearOutput: async () => {},
      replaceOutputItems: async () => {},
      appendOutputItems: async () => {},
    };
    const presenter = yield* VsCodeNotebookOutputPresenter.make.pipe(
      Effect.provide(code.layer),
    );

    yield* presenter.present(
      MarimoNotebookDocument.from(notebookEditor.notebook),
      { createNotebookCellExecution: () => execution },
      [savedReplay],
    );

    expect(events).toEqual(["start", "replace", "end:undefined"]);
    const rich = rendered
      .flat()
      .flatMap((output) => output.items)
      .find((item) => item.mime === "application/vnd.marimo.ui+json");
    expect(rich).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(rich?.data))).toMatchObject({
      state: { staleInputs: true },
    });
  }),
);

it.effect(
  "does not overwrite output already owned by the notebook",
  Effect.fn(function* () {
    const notebookEditor = editor([
      {
        items: [
          {
            mime: "text/plain",
            data: new TextEncoder().encode("current"),
          },
        ],
      },
    ]);
    const code = yield* TestVsCode.make({
      initialDocuments: [notebookEditor.notebook],
    });
    const presenter = yield* VsCodeNotebookOutputPresenter.make.pipe(
      Effect.provide(code.layer),
    );
    let executions = 0;

    yield* presenter.present(
      MarimoNotebookDocument.from(notebookEditor.notebook),
      {
        createNotebookCellExecution: () => {
          executions += 1;
          throw new Error("should not create an execution");
        },
      },
      [savedReplay],
    );

    expect(executions).toBe(0);
  }),
);
