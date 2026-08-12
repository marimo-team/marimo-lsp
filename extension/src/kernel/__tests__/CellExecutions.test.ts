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
import { CellExecutions, type Drive } from "../../kernel/CellExecutions.ts";
import {
  VsCodeCellDrive,
  type VsCodeDriveBinding,
} from "../../kernel/VsCodeCellDrive.ts";
import { buildCellOutputs } from "../../kernel/VsCodeCellOutputs.ts";
import {
  cellId,
  UNSAFE_castForNegativeTest,
} from "../../lib/__tests__/branded.ts";
import { VsCode } from "../../platform/VsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
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
    Layer.merge(CellExecutions.layer),
    Layer.merge(VsCodeCellDrive.layer),
    Layer.provide(TestNotebookRuntime),
    Layer.provide(TestTelemetryLive),
    Layer.provideMerge(vscode.layer),
  );
  return { vscode, layer };
});

const CELL_ID = cellId("test-cell-id");

const acceptCell = (
  executions: CellExecutions["Service"],
  host: VsCodeCellDrive["Service"],
  cell: MarimoNotebookCell,
  message: CellOperationNotification,
  controller: VsCodeDriveBinding["controller"],
  renderOutput?: boolean,
) =>
  executions.handleOperation(message, {
    notebookId: cell.notebook.id,
    source: cell.document.getText(),
    drive: host.bind({ notebook: cell.notebook, controller }),
    renderOutput,
  });

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
    "offers native stdout and rich media as alternate MIME representations",
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

      expect(outputs).toHaveLength(1);
      const output = outputs.at(0);
      if (output === undefined) throw new Error("Expected stdout output");
      expect(output.metadata).toEqual({ channel: "stdout" });
      expect(output.items.map((item) => item.mime)).toEqual([
        "application/vnd.code.notebook.stdout",
        "application/vnd.marimo.ui+json",
      ]);

      const richItem = output.items.at(1);
      if (richItem === undefined) throw new Error("Expected rich MIME item");
      expect(JSON.parse(new TextDecoder().decode(richItem.data))).toMatchObject(
        {
          state: { consoleOutputs: state.consoleOutputs },
        },
      );
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
      const executions = yield* CellExecutions;
      const host = yield* VsCodeCellDrive;
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

      yield* acceptCell(
        executions,
        host,
        MarimoNotebookDocument.from(firstEditor.notebook).cellAt(0),
        message,
        controller,
      );
      yield* acceptCell(
        executions,
        host,
        MarimoNotebookDocument.from(secondEditor.notebook).cellAt(0),
        message,
        controller,
      );

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
  "closes an active run when its cell is removed",
  Effect.fn(function* () {
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py", {
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
    });
    const ctx = yield* withTestCtx({ initialDocuments: [editor.notebook] });

    yield* Effect.gen(function* () {
      const executions = yield* CellExecutions;
      const cell = MarimoNotebookDocument.from(editor.notebook).cellAt(0);
      const cellId = Option.getOrThrow(cell.id);
      const commands: string[] = [];
      const drive: Drive = (_cell, command) =>
        Effect.sync(() => commands.push(command._tag));

      yield* executions.handleOperation(
        {
          op: "cell-op",
          cell_id: cellId,
          status: "queued",
          run_id: "run-1",
        },
        {
          notebookId: cell.notebook.id,
          source: cell.document.getText(),
          drive,
        },
      );
      yield* executions.removeCell(cell.notebook.id, cellId);
      yield* executions.removeCell(cell.notebook.id, cellId);

      expect(commands).toEqual(["SetDiagnostic", "OpenRun", "CloseRun"]);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "keeps commands on the Drive that opened their run",
  Effect.fn(function* () {
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py", {
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
    });
    const ctx = yield* withTestCtx({ initialDocuments: [editor.notebook] });

    yield* Effect.gen(function* () {
      const executions = yield* CellExecutions;
      const cell = MarimoNotebookDocument.from(editor.notebook).cellAt(0);
      const cellId = Option.getOrThrow(cell.id);
      const events: string[] = [];
      const namedDrive =
        (name: string): Drive =>
        (_cell, command) =>
          Effect.sync(() => {
            if ("runId" in command) {
              events.push(`${name}:${command._tag}:${command.runId}`);
            }
          });
      const first = namedDrive("first");
      const second = namedDrive("second");
      const accept = (message: CellOperationNotification, drive: Drive) =>
        executions.handleOperation(message, {
          notebookId: cell.notebook.id,
          source: cell.document.getText(),
          drive,
        });

      yield* accept(
        {
          op: "cell-op",
          cell_id: cellId,
          status: "queued",
          run_id: "run-1",
        },
        first,
      );
      yield* accept(
        {
          op: "cell-op",
          cell_id: cellId,
          status: "queued",
          run_id: "run-2",
        },
        second,
      );
      // Even if a later operation arrives with another current Drive, the
      // active run remains bound to the Drive that opened it.
      yield* accept(
        { op: "cell-op", cell_id: cellId, status: "running" },
        first,
      );

      expect(events).toEqual([
        "first:OpenRun:run-1",
        "first:CloseRun:run-1",
        "second:OpenRun:run-2",
        "second:StartRun:run-2",
        "second:RenderOutputs:run-2",
      ]);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "updates cell state without projecting skipped outputs",
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
      const executions = yield* CellExecutions;
      const host = yield* VsCodeCellDrive;
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

      yield* acceptCell(
        executions,
        host,
        cell,
        {
          op: "cell-op",
          cell_id: cid,
          status: "queued",
          run_id: "run",
        },
        controller,
      );
      yield* acceptCell(
        executions,
        host,
        cell,
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
        controller,
        false,
      );

      expect(projectionCalls).toEqual([]);

      yield* acceptCell(
        executions,
        host,
        cell,
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
        controller,
        true,
      );

      expect(projectionCalls).toEqual(["clear", "append"]);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "ignores a tagged operation from a superseded run",
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
      const executions = yield* CellExecutions;
      const host = yield* VsCodeCellDrive;
      const notebook = MarimoNotebookDocument.from(editor.notebook);
      const cell = notebook.cellAt(0);
      const cid = Option.getOrThrow(cell.id);
      const starts: Array<number | undefined> = [];
      const controller = {
        createNotebookCellExecution(): vscode.NotebookCellExecution {
          return {
            cell: cell.rawNotebookCell,
            executionOrder: undefined,
            token: {
              isCancellationRequested: false,
              onCancellationRequested: () => ({ dispose() {} }),
            },
            start(at) {
              starts.push(at);
            },
            end() {},
            async clearOutput() {},
            async appendOutput() {},
            async appendOutputItems() {},
            async replaceOutput() {},
            async replaceOutputItems() {},
          };
        },
      };

      yield* acceptCell(
        executions,
        host,
        cell,
        {
          op: "cell-op",
          cell_id: cid,
          status: "queued",
          run_id: "run-2",
        },
        controller,
      );
      yield* acceptCell(
        executions,
        host,
        cell,
        {
          op: "cell-op",
          cell_id: cid,
          status: "running",
          run_id: "run-1",
          timestamp: 1,
        },
        controller,
        false,
      );

      expect(starts).toEqual([]);

      yield* acceptCell(
        executions,
        host,
        cell,
        {
          op: "cell-op",
          cell_id: cid,
          status: "running",
          run_id: "run-2",
          timestamp: 2,
        },
        controller,
        false,
      );

      expect(starts).toEqual([2_000]);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "ignores a tagged operation after its run completes",
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
      const executions = yield* CellExecutions;
      const notebook = MarimoNotebookDocument.from(editor.notebook);
      const cell = notebook.cellAt(0);
      const cid = Option.getOrThrow(cell.id);
      let created = 0;
      const drive: Drive = (_cell, command) =>
        Effect.sync(() => {
          if (command._tag === "OpenRun") created += 1;
        });
      const options = { notebookId: cell.notebook.id, drive };

      yield* executions.handleOperation(
        {
          op: "cell-op",
          cell_id: cid,
          status: "queued",
          run_id: "run-1",
        },
        options,
      );
      yield* executions.handleOperation(
        {
          op: "cell-op",
          cell_id: cid,
          status: "idle",
          run_id: "run-1",
          timestamp: 1,
        },
        options,
      );
      expect(created).toBe(1);

      yield* executions.handleOperation(
        {
          op: "cell-op",
          cell_id: cid,
          status: "idle",
          run_id: "run-1",
          output: {
            mimetype: "application/vnd.marimo+error",
            channel: "marimo-error",
            data: [{ type: "syntax", msg: "late error" }],
          },
        },
        options,
      );

      expect(created).toBe(1);
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
      const executions = yield* CellExecutions;
      const host = yield* VsCodeCellDrive;
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

      yield* acceptCell(executions, host, cell, message, {
        createNotebookCellExecution: (value) =>
          controller.createNotebookCellExecution(value.rawNotebookCell),
      });

      // Check that CellExecutions tracked the cell as stale
      expect(
        yield* executions.isCellStale(
          MarimoNotebookCell.from(cell.rawNotebookCell),
        ),
      ).toBe(true);

      // Record execution to clear stale
      yield* executions.recordExecution(
        MarimoNotebookCell.from(cell.rawNotebookCell),
      );

      // Check that the cell is no longer stale
      expect(
        yield* executions.isCellStale(
          MarimoNotebookCell.from(cell.rawNotebookCell),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "accepts the submitted source when the cell changes before queued",
  Effect.fn(function* () {
    const cellData = {
      kind: 1,
      value: "x = 1",
      languageId: "python",
      metadata: MarimoNotebookCell.createMetadata({
        marimoRuntime: { stableId: "cell-1" },
      }),
    };
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py", {
      data: { cells: [cellData] },
    });
    const ctx = yield* withTestCtx({ initialDocuments: [editor.notebook] });

    yield* Effect.gen(function* () {
      const executions = yield* CellExecutions;
      const cell = MarimoNotebookDocument.from(editor.notebook).cellAt(0);
      const cellId = Option.getOrThrow(cell.id);
      const drive: Drive = () => Effect.void;

      yield* executions.submit(
        cell.notebook.id,
        [{ cellId, source: "x = 1" }],
        Effect.gen(function* () {
          cellData.value = "x = 2";
          yield* executions.handleOperation(
            {
              op: "cell-op",
              cell_id: cellId,
              status: "queued",
              run_id: "run-1",
            },
            { notebookId: cell.notebook.id, drive },
          );
        }),
      );

      expect(yield* executions.isCellStale(cell)).toBe(true);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "rolls back submitted sources when transport fails",
  Effect.fn(function* () {
    const cellData = {
      kind: 1,
      value: "x = 2",
      languageId: "python",
      metadata: MarimoNotebookCell.createMetadata({
        marimoRuntime: { stableId: "cell-1" },
      }),
    };
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py", {
      data: { cells: [cellData] },
    });
    const ctx = yield* withTestCtx({ initialDocuments: [editor.notebook] });

    yield* Effect.gen(function* () {
      const executions = yield* CellExecutions;
      const cell = MarimoNotebookDocument.from(editor.notebook).cellAt(0);
      const cellId = Option.getOrThrow(cell.id);
      const drive: Drive = () => Effect.void;

      yield* executions
        .submit(
          cell.notebook.id,
          [{ cellId, source: "x = 1" }],
          Effect.fail("transport failed"),
        )
        .pipe(Effect.flip);
      yield* executions.submit(
        cell.notebook.id,
        [{ cellId, source: "x = 2" }],
        executions.handleOperation(
          {
            op: "cell-op",
            cell_id: cellId,
            status: "queued",
            run_id: "run-1",
          },
          { notebookId: cell.notebook.id, drive },
        ),
      );

      expect(yield* executions.isCellStale(cell)).toBe(false);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "clears stale state when cell is queued for execution",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();

    yield* Effect.gen(function* () {
      const executions = yield* CellExecutions;
      const host = yield* VsCodeCellDrive;

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

      // First, invalidate the cell in CellExecutions
      yield* executions.invalidateCell(
        MarimoNotebookCell.from(cell.rawNotebookCell),
      );

      // Verify cell is tracked as stale
      expect(
        yield* executions.isCellStale(
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

      yield* acceptCell(executions, host, cell, message, {
        createNotebookCellExecution: (value) =>
          controller.createNotebookCellExecution(value.rawNotebookCell),
      });

      // Check that the cell's stale state was cleared
      expect(
        yield* executions.isCellStale(
          MarimoNotebookCell.from(cell.rawNotebookCell),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "logs and skips when queued message has no run_id",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();

    yield* Effect.gen(function* () {
      const executions = yield* CellExecutions;
      const host = yield* VsCodeCellDrive;

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

      // Mark the cell stale so we can prove the bail happens before recordExecution
      yield* executions.invalidateCell(
        MarimoNotebookCell.from(cell.rawNotebookCell),
      );
      expect(
        yield* executions.isCellStale(
          MarimoNotebookCell.from(cell.rawNotebookCell),
        ),
      ).toBe(true);

      const controller = yield* code.notebooks.createNotebookController(
        "test-controller",
        NOTEBOOK_TYPE,
        "test-controller",
      );

      // Pre-fix this would die via Option.getOrThrow on a None.
      const message: CellOperationNotification = {
        op: "cell-op",
        cell_id: cellId,
        status: "queued",
        run_id: null,
      };

      yield* acceptCell(executions, host, cell, message, {
        createNotebookCellExecution: (value) =>
          controller.createNotebookCellExecution(value.rawNotebookCell),
      });

      // Stale state preserved because we bail before recordExecution
      expect(
        yield* executions.isCellStale(
          MarimoNotebookCell.from(cell.rawNotebookCell),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

/**
 * Creates a controller whose `createNotebookCellExecution` throws,
 * simulating VS Code's "invalid cell" error when a cell is deleted.
 */
function makeThrowingController(): VsCodeDriveBinding["controller"] {
  return {
    createNotebookCellExecution() {
      throw new Error("invalid cell");
    },
  };
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
      const executions = yield* CellExecutions;
      const host = yield* VsCodeCellDrive;

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

      yield* acceptCell(executions, host, cell, message, controller);

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
      const executions = yield* CellExecutions;
      const host = yield* VsCodeCellDrive;

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

      yield* acceptCell(executions, host, cell, message, controller);

      // If we get here, the error was handled gracefully
      expect(true).toBe(true);
    }).pipe(Effect.provide(ctx.layer));
  }),
);
