import { expect, it } from "@effect/vitest";
import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import { Effect, Layer, Option, Stream, TestClock } from "effect";
import type * as vscode from "vscode";

import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import {
  createTestNotebookDocument,
  createTestNotebookEditor,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import {
  buildCellOutputs,
  ExecutionRegistry,
} from "../../kernel/ExecutionRegistry.ts";
import { PythonController } from "../../kernel/NotebookControllerFactory.ts";
import { LanguageClient } from "../../lsp/LanguageClient.ts";
import { CellStateManager } from "../../notebook/CellStateManager.ts";
import { VsCode } from "../../platform/VsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../../schemas/MarimoNotebookDocument.ts";
import type { NotebookCellId } from "../../schemas/MarimoNotebookDocument.ts";
import type {
  CellOperationNotification,
  CellRuntimeState,
} from "../../types.ts";

// Simple mock LanguageClient that doesn't spawn a real LSP process
const TestLanguageClientMock = Layer.succeed(
  LanguageClient,
  LanguageClient.make({
    channel: { name: "marimo-lsp", show() {} },
    restart: () => Effect.void,
    executeCommand() {
      return Effect.void;
    },
    streamOf() {
      return Stream.never;
    },
  }),
);

const withTestCtx = Effect.fn(function* (
  options: Parameters<(typeof TestVsCode)["make"]>[0] = {},
) {
  const vscode = yield* TestVsCode.make(options);
  const layer = Layer.empty.pipe(
    Layer.merge(ExecutionRegistry.Default),
    Layer.merge(CellStateManager.Default),
    Layer.provide(TestLanguageClientMock),
    Layer.provide(TestTelemetryLive),
    Layer.provideMerge(vscode.layer),
  );
  return { vscode, layer };
});

const CELL_ID = "test-cell-id" as NotebookCellId;

// Convert Uint8Array data to strings for readable snapshots
function normalizeOutputsForSnapshot(
  outputs: Array<vscode.NotebookCellOutput>,
) {
  if (!Array.isArray(outputs)) {
    return outputs;
  }

  return outputs.map((output) => {
    if (!output.items) {
      return output;
    }

    return {
      ...output,
      items: output.items.map((item) => {
        if (item.data instanceof Uint8Array) {
          const decoder = new TextDecoder();
          return {
            ...item,
            data: decoder.decode(item.data),
          };
        }
        return item;
      }),
    };
  });
}

describe("buildCellOutputs", () => {
  it.effect(
    "handles stdout output",

    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const state: CellRuntimeState = {
          ...createCellRuntimeState(),
          consoleOutputs: [
            {
              mimetype: "text/plain",
              channel: "stdout",
              data: "Hello from stdout",
              timestamp: 0,
            },
          ],
        };
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles stderr output",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const state: CellRuntimeState = {
          ...createCellRuntimeState(),
          consoleOutputs: [
            {
              mimetype: "text/plain",
              channel: "stderr",
              data: "Error message",
              timestamp: 0,
            },
          ],
        };

        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles multiple console outputs",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const state: CellRuntimeState = {
          ...createCellRuntimeState(),
          consoleOutputs: [
            {
              mimetype: "text/plain",
              channel: "stdout",
              data: "Line 1\n",
              timestamp: 0,
            },
            {
              mimetype: "text/plain",
              channel: "stdout",
              data: "Line 2\n",
              timestamp: 1,
            },
            {
              mimetype: "text/plain",
              channel: "stderr",
              data: "Warning: something happened\n",
              timestamp: 2,
            },
          ],
        };

        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles marimo error output",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const state: CellRuntimeState = {
          ...createCellRuntimeState(),
          output: {
            mimetype: "application/vnd.marimo+error",
            channel: "marimo-error",
            data: [
              {
                type: "syntax",
                msg: "Invalid syntax",
                cell_id: CELL_ID.toString(),
              },
            ],
            timestamp: 0,
          },
        };
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles HTML output",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();
      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const state: CellRuntimeState = {
          ...createCellRuntimeState(),
          output: {
            mimetype: "text/html",
            channel: "output",
            data: "<div>Hello <b>world</b></div>",
            timestamp: 0,
          },
        };

        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles JSON output",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const state: CellRuntimeState = {
          ...createCellRuntimeState(),
          output: {
            mimetype: "application/json",
            channel: "output",
            data: { foo: "bar", count: 42 },
            timestamp: 0,
          },
        };
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles mixed output and console streams",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();
      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const state: CellRuntimeState = {
          ...createCellRuntimeState(),
          consoleOutputs: [
            {
              mimetype: "text/plain",
              channel: "stdout",
              data: "Processing...\n",
              timestamp: 0,
            },
            {
              mimetype: "text/plain",
              channel: "stderr",
              data: "Warning: deprecated function\n",
              timestamp: 1,
            },
          ],
          output: {
            mimetype: "text/html",
            channel: "output",
            data: "<div>Result: 42</div>",
            timestamp: 2,
          },
        };

        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles stdin output",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const state: CellRuntimeState = {
          ...createCellRuntimeState(),
          consoleOutputs: [
            {
              mimetype: "text/plain",
              channel: "stdin",
              data: "Enter your name: ",
              timestamp: 0,
            },
          ],
        };

        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles empty state",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const state: CellRuntimeState = createCellRuntimeState();
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      // Should still have the marimo UI output
      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles multiple errors in marimo error output",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const state: CellRuntimeState = {
          ...createCellRuntimeState(),
          output: {
            mimetype: "application/vnd.marimo+error",
            channel: "marimo-error",
            data: [
              {
                type: "exception",
                msg: "ValueError: invalid value",
                exception_type: "ValueError",
              },
              {
                type: "ancestor-stopped",
                msg: "Ancestor cell was stopped",
                raising_cell: "other-cell-id",
              },
            ],
            timestamp: 0,
          },
        };
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles multiple stderr errors",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const state: CellRuntimeState = {
          ...createCellRuntimeState(),
          consoleOutputs: [
            {
              mimetype: "text/plain",
              channel: "stderr",
              data: "Error 1: Connection failed\n",
              timestamp: 0,
            },
            {
              mimetype: "text/plain",
              channel: "stderr",
              data: "Error 2: Retry failed\n",
              timestamp: 1,
            },
            {
              mimetype: "text/plain",
              channel: "stderr",
              data: "Error 3: Timeout\n",
              timestamp: 2,
            },
          ],
        };

        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles stdout + stderr + output together",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const state: CellRuntimeState = {
          ...createCellRuntimeState(),
          consoleOutputs: [
            {
              mimetype: "text/plain",
              channel: "stdout",
              data: "Starting computation...\n",
              timestamp: 0,
            },
            {
              mimetype: "text/plain",
              channel: "stderr",
              data: "Warning: using deprecated API\n",
              timestamp: 1,
            },
            {
              mimetype: "text/plain",
              channel: "stdout",
              data: "Computation complete\n",
              timestamp: 2,
            },
          ],
          output: {
            mimetype: "application/json",
            channel: "output",
            data: { result: "success", value: 100 },
            timestamp: 3,
          },
        };

        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles application/vnd.marimo+traceback output",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const state: CellRuntimeState = {
          ...createCellRuntimeState(),
          output: {
            mimetype: "application/vnd.marimo+traceback",
            channel: "output",
            data: '<b>Traceback (most recent call last):</b>\n  File "<stdin>", line 1, in <module>\nTypeError: invalid value',
          },
        };

        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "filters out empty text/plain stdout output",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      const state: CellRuntimeState = {
        ...createCellRuntimeState(),
        consoleOutputs: [
          {
            mimetype: "text/plain",
            channel: "stdout",
            data: "",
            timestamp: 0,
          },
        ],
      };

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "filters out empty text/plain stderr output",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      const state: CellRuntimeState = {
        ...createCellRuntimeState(),
        consoleOutputs: [
          {
            mimetype: "text/plain",
            channel: "stderr",
            data: "",
            timestamp: 0,
          },
        ],
      };

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "filters out empty traceback output",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      const state: CellRuntimeState = {
        ...createCellRuntimeState(),
        output: {
          mimetype: "application/vnd.marimo+traceback",
          channel: "output",
          data: "",
        },
      };

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "filters out null output data",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      const state: CellRuntimeState = {
        ...createCellRuntimeState(),
        output: {
          mimetype: "text/plain",
          channel: "output",
          data: null as unknown as string,
        },
      };

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "filters out undefined output data",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      const state: CellRuntimeState = {
        ...createCellRuntimeState(),
        output: {
          mimetype: "text/html",
          channel: "output",
          data: undefined as unknown as string,
        },
      };

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles mix of empty and non-empty console outputs",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();
      const state: CellRuntimeState = {
        ...createCellRuntimeState(),
        consoleOutputs: [
          {
            mimetype: "text/plain",
            channel: "stdout",
            data: "",
            timestamp: 0,
          },
          {
            mimetype: "text/plain",
            channel: "stdout",
            data: "Actual output\n",
            timestamp: 1,
          },
          {
            mimetype: "text/plain",
            channel: "stderr",
            data: "",
            timestamp: 2,
          },
          {
            mimetype: "text/plain",
            channel: "stderr",
            data: "Actual error\n",
            timestamp: 3,
          },
        ],
      };

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles null output object",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      const state: CellRuntimeState = {
        ...createCellRuntimeState(),
        output: null,
      };

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles empty marimo error data array",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();
      const state: CellRuntimeState = {
        ...createCellRuntimeState(),
        output: {
          mimetype: "application/vnd.marimo+error",
          channel: "marimo-error",
          data: [],
          timestamp: 0,
        },
      };

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "preserves whitespace-only output",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();
      const state: CellRuntimeState = {
        ...createCellRuntimeState(),
        consoleOutputs: [
          {
            mimetype: "text/plain",
            channel: "stdout",
            data: "   ",
            timestamp: 0,
          },
        ],
      };

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles numeric zero output",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();
      const state: CellRuntimeState = {
        ...createCellRuntimeState(),
        output: {
          mimetype: "application/json",
          channel: "output",
          data: 0 as unknown as string,
          timestamp: 0,
        },
      };

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles boolean false output",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();
      const state: CellRuntimeState = {
        ...createCellRuntimeState(),
        output: {
          mimetype: "application/json",
          channel: "output",
          data: false as unknown as string,
          timestamp: 0,
        },
      };

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles media channel in console outputs",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();
      const state: CellRuntimeState = {
        ...createCellRuntimeState(),
        consoleOutputs: [
          {
            mimetype: "image/png",
            channel: "media",
            data: "base64encodedimagedata",
            timestamp: 0,
          },
        ],
      };

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "ignores output/marimo-error/pdb channels in console outputs",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();
      const state: CellRuntimeState = {
        ...createCellRuntimeState(),
        consoleOutputs: [
          {
            mimetype: "text/plain",
            channel: "stdout",
            data: "Normal stdout",
            timestamp: 0,
          },
          {
            mimetype: "text/plain",
            channel: "output",
            data: "Should be ignored",
            timestamp: 1,
          },
          {
            mimetype: "application/vnd.marimo+error",
            channel: "marimo-error",
            data: "Should be ignored",
            timestamp: 2,
          },
          {
            mimetype: "text/plain",
            channel: "pdb",
            data: "Should be ignored",
            timestamp: 3,
          },
        ],
      };

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      // Should only have stdout output, the other channels should be ignored
      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "separates console outputs from main output correctly",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();
      const state: CellRuntimeState = {
        ...createCellRuntimeState(),
        consoleOutputs: [
          {
            mimetype: "text/plain",
            channel: "stdout",
            data: "Console output",
            timestamp: 0,
          },
        ],
        output: {
          mimetype: "text/html",
          channel: "output",
          data: "<div>Main output</div>",
          timestamp: 1,
        },
      };

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      // Both outputs should be present but in separate channels
      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles media channel with stdout in console outputs",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();
      const state: CellRuntimeState = {
        ...createCellRuntimeState(),
        consoleOutputs: [
          {
            mimetype: "text/plain",
            channel: "stdout",
            data: "Text output\n",
            timestamp: 0,
          },
          {
            mimetype: "image/png",
            channel: "media",
            data: "imagedata",
            timestamp: 1,
          },
        ],
      };

      const outputs = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      // Both stdout and media should be in the stdout channel
      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );
});

it.scoped(
  "marks cell as stale when message has staleInputs",
  Effect.fn(function* () {
    const editor = TestVsCode.makeNotebookEditor(
      "file:///test/notebook_mo.py",
      {
        data: {
          cells: [
            {
              kind: 1, // Code
              value: "x = 1",
              languageId: "python",
              metadata: {
                stableId: "cell-1",
              },
            },
          ],
        },
      },
    );

    const ctx = yield* withTestCtx({ initialDocuments: [editor.notebook] });

    yield* Effect.gen(function* () {
      const registry = yield* ExecutionRegistry;
      const cellStateManager = yield* CellStateManager;
      const code = yield* VsCode;

      const notebook = MarimoNotebookDocument.from(editor.notebook);
      const cell = notebook.cellAt(0);

      // Set active editor in testVsCode so NotebookEditorRegistry can find it
      yield* ctx.vscode.setActiveNotebookEditor(Option.some(editor));

      // Wait for NotebookEditorRegistry to process the change
      yield* TestClock.adjust("10 millis");

      // Create a mock controller
      const controller = yield* code.notebooks.createNotebookController(
        "test-controller",
        NOTEBOOK_TYPE,
        "test-controller",
      );

      // Send a message with staleInputs: true
      const message: CellOperationNotification = {
        op: "cell-op",
        cell_id: Option.getOrThrow(cell.id),
        status: "idle",
        stale_inputs: true,
      };

      yield* registry.handleCellOperation(message, {
        editor,
        controller: new PythonController(controller, "test-controller"),
      });

      // Check that CellStateManager tracked the cell as stale
      expect(
        yield* cellStateManager.isCellStale(
          MarimoNotebookCell.from(cell.rawNotebookCell),
        ),
      ).toBe(true);

      // Record execution to clear stale
      yield* cellStateManager.recordExecution(
        MarimoNotebookCell.from(cell.rawNotebookCell),
      );

      // Check that the cell is no longer stale
      expect(
        yield* cellStateManager.isCellStale(
          MarimoNotebookCell.from(cell.rawNotebookCell),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.scoped(
  "clears stale state when cell is queued for execution",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();

    yield* Effect.gen(function* () {
      const registry = yield* ExecutionRegistry;
      const cellStateManager = yield* CellStateManager;

      // Create a test notebook with a stale cell
      const cellData = {
        kind: 1, // Code
        value: "x = 1",
        languageId: "python",
        metadata: {
          name: "test_cell",
          state: "stale",
          stableId: "cell-1",
        },
      };
      const notebook = MarimoNotebookDocument.from(
        createTestNotebookDocument("file:///test/notebook_mo.py", {
          data: { cells: [cellData] },
        }),
      );
      const editor = createTestNotebookEditor(notebook.rawNotebookDocument);
      const cell = notebook.cellAt(0);
      const cellId = Option.getOrThrow(cell.id);
      const code = yield* VsCode;

      // Set active editor in testVsCode so NotebookEditorRegistry can find it
      yield* ctx.vscode.setActiveNotebookEditor(Option.some(editor));

      // Wait for NotebookEditorRegistry to process the change
      yield* TestClock.adjust("10 millis");

      // First, invalidate the cell in CellStateManager
      yield* cellStateManager.invalidateCell(
        MarimoNotebookCell.from(cell.rawNotebookCell),
      );

      // Verify cell is tracked as stale
      expect(
        yield* cellStateManager.isCellStale(
          MarimoNotebookCell.from(cell.rawNotebookCell),
        ),
      ).toBe(true);

      // Create a mock controller
      const controller = yield* code.notebooks.createNotebookController(
        "test-controller",
        NOTEBOOK_TYPE,
        "test-controller",
      );

      // Send a queued message
      const message: CellOperationNotification = {
        op: "cell-op",
        cell_id: cellId,
        status: "queued",
        run_id: "test-run-id",
      };

      yield* registry.handleCellOperation(message, {
        editor,
        controller: new PythonController(controller, "test-controller"),
      });

      // Check that the cell's stale state was cleared
      expect(
        yield* cellStateManager.isCellStale(
          MarimoNotebookCell.from(cell.rawNotebookCell),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

/**
 * Creates a PythonController whose `createNotebookCellExecution` throws,
 * simulating VS Code's "invalid cell" error when a cell is deleted.
 */
function makeThrowingController(): PythonController {
  const inner: Omit<vscode.NotebookController, "dispose"> = {
    id: "throwing-controller",
    notebookType: NOTEBOOK_TYPE,
    label: "throwing-controller",
    supportedLanguages: undefined,
    description: undefined,
    detail: undefined,
    supportsExecutionOrder: undefined,
    executeHandler: () => {},
    interruptHandler: undefined,
    onDidChangeSelectedNotebooks: () => ({ dispose() {} }),
    updateNotebookAffinity() {},
    createNotebookCellExecution() {
      throw new Error("invalid cell");
    },
  };
  return new PythonController(inner, "/usr/bin/python3");
}

it.scoped(
  "handles InvalidCellError when createNotebookCellExecution throws on queued",
  Effect.fn(function* () {
    const editor = TestVsCode.makeNotebookEditor(
      "file:///test/notebook_mo.py",
      {
        data: {
          cells: [
            {
              kind: 1,
              value: "x = 1",
              languageId: "python",
              metadata: { stableId: "cell-1" },
            },
          ],
        },
      },
    );

    const ctx = yield* withTestCtx({ initialDocuments: [editor.notebook] });

    yield* Effect.gen(function* () {
      const registry = yield* ExecutionRegistry;

      const notebook = MarimoNotebookDocument.from(editor.notebook);
      const cell = notebook.cellAt(0);
      const cellId = Option.getOrThrow(cell.id);

      yield* ctx.vscode.setActiveNotebookEditor(Option.some(editor));
      yield* TestClock.adjust("10 millis");

      const controller = makeThrowingController();

      // Should not throw — the InvalidCellError is caught and logged as warning
      const message: CellOperationNotification = {
        op: "cell-op",
        cell_id: cellId,
        status: "queued",
        run_id: "test-run-id",
      };

      yield* registry.handleCellOperation(message, {
        editor,
        controller,
      });

      // If we get here, the error was handled gracefully
      expect(true).toBe(true);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.scoped(
  "handles InvalidCellError on ephemeral execution for marimo error",
  Effect.fn(function* () {
    const editor = TestVsCode.makeNotebookEditor(
      "file:///test/notebook_mo.py",
      {
        data: {
          cells: [
            {
              kind: 1,
              value: "x = 1",
              languageId: "python",
              metadata: { stableId: "cell-1" },
            },
          ],
        },
      },
    );

    const ctx = yield* withTestCtx({ initialDocuments: [editor.notebook] });

    yield* Effect.gen(function* () {
      const registry = yield* ExecutionRegistry;

      const notebook = MarimoNotebookDocument.from(editor.notebook);
      const cell = notebook.cellAt(0);
      const cellId = Option.getOrThrow(cell.id);

      yield* ctx.vscode.setActiveNotebookEditor(Option.some(editor));
      yield* TestClock.adjust("10 millis");

      const controller = makeThrowingController();

      // Send an idle message with a marimo error output — this triggers the
      // ephemeral execution path where createNotebookCellExecution is called
      // without a prior queued message.
      const message: CellOperationNotification = {
        op: "cell-op",
        cell_id: cellId,
        status: "idle",
        output: {
          mimetype: "application/vnd.marimo+error",
          channel: "marimo-error",
          data: [{ type: "syntax", msg: "Invalid syntax" }],
          timestamp: 0,
        },
      };

      yield* registry.handleCellOperation(message, {
        editor,
        controller,
      });

      // If we get here, the error was handled gracefully
      expect(true).toBe(true);
    }).pipe(Effect.provide(ctx.layer));
  }),
);
