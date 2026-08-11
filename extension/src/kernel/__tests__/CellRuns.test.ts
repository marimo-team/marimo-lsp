import { describe, expect, it } from "@effect/vitest";
import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import { Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import type * as vscode from "vscode";

import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import {
  createTestNotebookDocument,
  createTestNotebookEditor,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import { CellRunInput, CellRuns } from "../../kernel/CellRuns.ts";
import { buildCellOutputs } from "../../kernel/VsCodeCellOutputs.ts";
import {
  type VsCodeCellRunBinding,
  VsCodeCellRunPresentation,
} from "../../kernel/VsCodeCellRunPresentation.ts";
import {
  cellId,
  UNSAFE_castForNegativeTest,
} from "../../lib/__tests__/branded.ts";
import { VsCode } from "../../platform/VsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
  type NotebookCellId,
} from "../../schemas/MarimoNotebookDocument.ts";
import type {
  CellOperationNotification,
  CellRuntimeState,
} from "../../types.ts";

const TestNotebookRuntime = makeTestNotebookRuntime();

const withTestCtx = Effect.fn(function* (
  options: Parameters<(typeof TestVsCode)["make"]>[0] = {},
) {
  const vscode = yield* TestVsCode.make(options);
  const layer = Layer.empty.pipe(
    Layer.merge(CellRuns.layer),
    Layer.merge(VsCodeCellRunPresentation.layer),
    Layer.provide(TestNotebookRuntime),
    Layer.provide(TestTelemetryLive),
    Layer.provideMerge(vscode.layer),
  );
  return { vscode, layer };
});

const acceptOperations = Effect.fn(function* (
  operations: ReadonlyArray<CellOperationNotification>,
  binding: {
    readonly editor: vscode.NotebookEditor;
    readonly controller: VsCodeCellRunBinding["controller"];
  },
) {
  const cellRuns = yield* CellRuns;
  const presentations = yield* VsCodeCellRunPresentation;
  const notebook = MarimoNotebookDocument.from(binding.editor.notebook);
  const sourceByCell = new Map<NotebookCellId, string>();
  for (const cell of notebook.getCells()) {
    if (Option.isSome(cell.id)) {
      sourceByCell.set(cell.id.value, cell.document.getText());
    }
  }
  yield* cellRuns.accept(
    CellRunInput.Operations({
      notebookId: notebook.id,
      operations,
      sourceByCell,
      presentation: presentations.bind({
        notebook,
        controller: binding.controller,
      }),
    }),
  );
});

const asCellRunController = (
  controller: Omit<vscode.NotebookController, "dispose">,
): VsCodeCellRunBinding["controller"] => ({
  createNotebookCellExecution: (cell) =>
    controller.createNotebookCellExecution(cell.rawNotebookCell),
});

const cellSnapshot = (cell: MarimoNotebookCell) => ({
  notebookId: cell.notebook.id,
  cellId: Option.getOrThrow(cell.id),
  source: cell.document.getText(),
});

const CELL_ID = cellId("test-cell-id");

// Convert Uint8Array data to strings for readable snapshots
function normalizeOutputsForSnapshot(
  outputs: Array<vscode.NotebookCellOutput>,
) {
  if (!Array.isArray(outputs)) {
    return outputs;
  }

  const decoder = new TextDecoder();
  return outputs.map((output) => ({
    items: output.items.map((item) => ({
      mime: item.mime,
      data:
        item.data instanceof Uint8Array ? decoder.decode(item.data) : item.data,
    })),
    metadata: output.metadata,
  }));
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
            data: '<div class="highlight"><pre>Traceback (most recent call last):\n  File <span class="s">&quot;/tmp/foo.py&quot;</span>, line 1, in &lt;module&gt;\nTypeError: invalid value</pre></div>',
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
    "suppresses redundant exception marimo-error when a traceback is also present",
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
                msg: "division by zero",
                exception_type: "ZeroDivisionError",
              },
            ],
            timestamp: 0,
          },
          consoleOutputs: [
            {
              mimetype: "application/vnd.marimo+traceback",
              channel: "stderr",
              data: "Traceback (most recent call last):\n  File &quot;/tmp/cell.py&quot;, line 1, in &lt;module&gt;\nZeroDivisionError: division by zero",
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
    "keeps strict-exception marimo-error even when a traceback is present",
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
                type: "strict-exception",
                msg: "name 'x' is not defined",
                ref: "x",
                blamed_cell: cellId("blamed-cell-id"),
              },
            ],
            timestamp: 0,
          },
          consoleOutputs: [
            {
              mimetype: "application/vnd.marimo+traceback",
              channel: "stderr",
              data: "Traceback (most recent call last):\n  File &quot;/tmp/cell.py&quot;, line 1, in &lt;module&gt;\nNameError: name 'x' is not defined",
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
    "keeps exception marimo-error with raising_cell even when a traceback is present",
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
                msg: "division by zero",
                exception_type: "ZeroDivisionError",
                raising_cell: cellId("raising-cell-id"),
              },
            ],
            timestamp: 0,
          },
          consoleOutputs: [
            {
              mimetype: "application/vnd.marimo+traceback",
              channel: "stderr",
              data: "Traceback (most recent call last):\n  File &quot;/tmp/cell.py&quot;, line 1, in &lt;module&gt;\nZeroDivisionError: division by zero",
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
    "keeps marimo-error rule violations even when a traceback is present",
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
                type: "multiple-defs",
                name: "x",
                cells: [cellId("other-cell-id")],
              },
            ],
            timestamp: 0,
          },
          consoleOutputs: [
            {
              mimetype: "application/vnd.marimo+traceback",
              channel: "stderr",
              data: "Traceback (most recent call last):\n  File &quot;/tmp/cell.py&quot;, line 1\nNameError: unused",
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
    // A stderr log (e.g. from the stdlib logging module) and the traceback are
    // both stderr console outputs; they must not collapse into one output.
    "keeps the traceback in its own output when a stderr log precedes it",
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
                msg: "boom",
                exception_type: "ValueError",
              },
            ],
            timestamp: 0,
          },
          consoleOutputs: [
            {
              mimetype: "text/plain",
              channel: "stderr",
              data: "10:09:20 [INFO] some message\n",
              timestamp: 0,
            },
            {
              mimetype: "application/vnd.marimo+traceback",
              channel: "stderr",
              data: 'Traceback (most recent call last):\n  File "cell1", line 2, in <module>\nValueError: boom',
              timestamp: 1,
            },
          ],
        };
        return buildCellOutputs(CELL_ID, state, code);
      }).pipe(Effect.provide(ctx.layer));

      const normalized = normalizeOutputsForSnapshot(outputs);

      const hasLog = normalized.some((o) =>
        o.items.some(
          (i) => typeof i.data === "string" && i.data.includes("some message"),
        ),
      );
      expect(hasLog, "stderr log should be rendered").toBe(true);

      const errorOutput = normalized.find((o) =>
        o.items.some((i) => i.mime === "application/vnd.code.notebook.error"),
      );
      expect(
        errorOutput,
        "traceback should render as a structured error output",
      ).toBeDefined();
      expect(
        errorOutput?.items.every(
          (i) => i.mime === "application/vnd.code.notebook.error",
        ),
        "error output must not also carry the plain-text log item",
      ).toBe(true);
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
          data: UNSAFE_castForNegativeTest<string>(null),
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
          data: UNSAFE_castForNegativeTest<string>(undefined),
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
          data: UNSAFE_castForNegativeTest<string>(0),
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
          data: UNSAFE_castForNegativeTest<string>(false),
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

it.effect(
  "tracks equal cell IDs independently across notebooks",
  Effect.fn(function* () {
    const makeEditor = (path: string) =>
      TestVsCode.makeNotebookEditor(path, {
        data: {
          cells: [
            {
              kind: 1,
              value: "x = 1",
              languageId: "python",
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "shared-cell" },
              }),
            },
          ],
        },
      });
    const firstEditor = makeEditor("/test/first_notebook_mo.py");
    const secondEditor = makeEditor("/test/second_notebook_mo.py");
    const ctx = yield* withTestCtx({
      initialDocuments: [firstEditor.notebook, secondEditor.notebook],
    });

    yield* Effect.gen(function* () {
      const code = yield* VsCode;
      const vscodeController = yield* code.notebooks.createNotebookController(
        "test-controller",
        NOTEBOOK_TYPE,
        "test-controller",
      );
      const createdFor: string[] = [];
      const controller = {
        createNotebookCellExecution(cell: MarimoNotebookCell) {
          createdFor.push(cell.notebook.id);
          return vscodeController.createNotebookCellExecution(
            cell.rawNotebookCell,
          );
        },
      };
      const message: CellOperationNotification = {
        op: "cell-op",
        cell_id: cellId("shared-cell"),
        status: "queued",
        run_id: "shared-run",
      };

      yield* acceptOperations([message], {
        editor: firstEditor,
        controller,
      });
      yield* acceptOperations([message], {
        editor: secondEditor,
        controller,
      });

      expect(createdFor.toSorted((a, b) => a.localeCompare(b))).toEqual(
        [
          MarimoNotebookDocument.from(firstEditor.notebook).id,
          MarimoNotebookDocument.from(secondEditor.notebook).id,
        ].toSorted((a, b) => a.localeCompare(b)),
      );
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "projects only the latest renderable output in a batch",
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
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "cell-1" },
              }),
            },
          ],
        },
      },
    );
    const ctx = yield* withTestCtx({ initialDocuments: [editor.notebook] });

    yield* Effect.gen(function* () {
      const notebook = MarimoNotebookDocument.from(editor.notebook);
      const cell = notebook.cellAt(0);
      const cid = Option.getOrThrow(cell.id);
      const projectionCalls: string[] = [];

      const controller = {
        createNotebookCellExecution(): vscode.NotebookCellExecution {
          return {
            cell: cell.rawNotebookCell,
            executionOrder: undefined,
            token: {
              isCancellationRequested: false,
              onCancellationRequested: () => ({ dispose() {} }),
            },
            start() {},
            end() {},
            async clearOutput() {
              projectionCalls.push("clear");
            },
            async appendOutput() {
              projectionCalls.push("append");
            },
            async appendOutputItems() {},
            async replaceOutput() {},
            async replaceOutputItems() {
              projectionCalls.push("replace-items");
            },
          };
        },
      };

      yield* acceptOperations(
        [
          {
            op: "cell-op",
            cell_id: cid,
            status: "queued",
            run_id: "run",
          },
          {
            op: "cell-op",
            cell_id: cid,
            status: "running",
            output: {
              channel: "output",
              mimetype: "text/plain",
              data: "superseded",
              timestamp: 0,
            },
          },
          {
            op: "cell-op",
            cell_id: cid,
            status: "running",
            output: {
              channel: "output",
              mimetype: "text/plain",
              data: "latest",
              timestamp: 1,
            },
          },
          {
            op: "cell-op",
            cell_id: cid,
            serialization: "state-only trailer",
          },
        ],
        { editor, controller },
      );

      expect(projectionCalls).toEqual(["clear", "append"]);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
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
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "cell-1" },
              }),
            },
          ],
        },
      },
    );

    const ctx = yield* withTestCtx({ initialDocuments: [editor.notebook] });

    yield* Effect.gen(function* () {
      const executions = yield* CellRuns;
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

      const cellRunController = asCellRunController(controller);
      yield* acceptOperations([message], {
        editor,
        controller: cellRunController,
      });

      // Check that CellRuns tracked the cell as stale
      expect(yield* executions.isStale(cellSnapshot(cell))).toBe(true);

      // A queue notification records the source accepted by the kernel.
      yield* acceptOperations(
        [
          {
            op: "cell-op",
            cell_id: Option.getOrThrow(cell.id),
            status: "queued",
            run_id: "accepted-run",
          },
        ],
        { editor, controller: cellRunController },
      );

      // Check that the cell is no longer stale
      expect(yield* executions.isStale(cellSnapshot(cell))).toBe(false);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "clears stale state when cell is queued for execution",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();

    yield* Effect.gen(function* () {
      const executions = yield* CellRuns;

      // Create a test notebook with a stale cell
      const cellData = {
        kind: 1, // Code
        value: "x = 1",
        languageId: "python",
        metadata: MarimoNotebookCell.createMetadata({
          marimo: { name: "test_cell" },
          marimoRuntime: { state: "stale", stableId: "cell-1" },
        }),
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

      const controller = yield* code.notebooks.createNotebookController(
        "test-controller",
        NOTEBOOK_TYPE,
        "test-controller",
      );
      const cellRunController = asCellRunController(controller);

      yield* acceptOperations(
        [{ op: "cell-op", cell_id: cellId, stale_inputs: true }],
        { editor, controller: cellRunController },
      );

      // Verify cell is tracked as stale
      expect(yield* executions.isStale(cellSnapshot(cell))).toBe(true);

      // Send a queued message
      const message: CellOperationNotification = {
        op: "cell-op",
        cell_id: cellId,
        status: "queued",
        run_id: "test-run-id",
      };

      yield* acceptOperations([message], {
        editor,
        controller: cellRunController,
      });

      // Check that the cell's stale state was cleared
      expect(yield* executions.isStale(cellSnapshot(cell))).toBe(false);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "logs and skips when queued message has no run_id",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();

    yield* Effect.gen(function* () {
      const executions = yield* CellRuns;

      const cellData = {
        kind: 1, // Code
        value: "x = 1",
        languageId: "python",
        metadata: MarimoNotebookCell.createMetadata({
          marimo: { name: "test_cell" },
          marimoRuntime: { state: "stale", stableId: "cell-1" },
        }),
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

      yield* ctx.vscode.setActiveNotebookEditor(Option.some(editor));
      yield* TestClock.adjust("10 millis");

      const controller = yield* code.notebooks.createNotebookController(
        "test-controller",
        NOTEBOOK_TYPE,
        "test-controller",
      );
      const cellRunController = asCellRunController(controller);

      // Mark the cell stale so we can prove the invalid queue cannot record it.
      yield* acceptOperations(
        [{ op: "cell-op", cell_id: cellId, stale_inputs: true }],
        { editor, controller: cellRunController },
      );
      expect(yield* executions.isStale(cellSnapshot(cell))).toBe(true);

      // Pre-fix this would die via Option.getOrThrow on a None.
      const message: CellOperationNotification = {
        op: "cell-op",
        cell_id: cellId,
        status: "queued",
        run_id: null,
      };

      yield* acceptOperations([message], {
        editor,
        controller: cellRunController,
      });

      // Stale state preserved because we bail before acceptSource
      expect(yield* executions.isStale(cellSnapshot(cell))).toBe(true);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

/**
 * Creates a cell-run presentation controller whose execution factory throws,
 * simulating VS Code's "invalid cell" error when a cell is deleted.
 */
function makeThrowingController(): VsCodeCellRunBinding["controller"] {
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
  return asCellRunController(inner);
}

it.effect(
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
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "cell-1" },
              }),
            },
          ],
        },
      },
    );

    const ctx = yield* withTestCtx({ initialDocuments: [editor.notebook] });

    yield* Effect.gen(function* () {
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

      yield* acceptOperations([message], { editor, controller });

      // If we get here, the error was handled gracefully
      expect(true).toBe(true);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
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
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "cell-1" },
              }),
            },
          ],
        },
      },
    );

    const ctx = yield* withTestCtx({ initialDocuments: [editor.notebook] });

    yield* Effect.gen(function* () {
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

      yield* acceptOperations([message], { editor, controller });

      // If we get here, the error was handled gracefully
      expect(true).toBe(true);
    }).pipe(Effect.provide(ctx.layer));
  }),
);
