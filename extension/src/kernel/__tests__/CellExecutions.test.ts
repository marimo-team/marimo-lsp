import { describe, expect, it } from "@effect/vitest";
import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import {
  Context,
  Effect,
  Fiber,
  HashSet,
  Layer,
  Latch,
  Option,
  Ref,
  Stream,
} from "effect";
import type * as vscode from "vscode";

import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import {
  createNotebookCell,
  NotebookRange,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import {
  CellExecutions,
  type Drive,
  type NotebookExecutions,
} from "../../kernel/CellExecutions.ts";
import { CellCommand } from "../../kernel/CellRunReducer.ts";
import { buildCellOutputs } from "../../kernel/VsCodeCellOutputs.ts";
import {
  cellId,
  runId,
  UNSAFE_castForNegativeTest,
} from "../../lib/__tests__/branded.ts";
import { NotebookDocumentSessions } from "../../notebook/NotebookDocumentSessions.ts";
import { VsCode } from "../../platform/VsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
  type NotebookCellId,
} from "../../schemas/MarimoNotebookDocument.ts";
import type { CellRuntimeState } from "../../types.ts";

const TestNotebookRuntime = makeTestNotebookRuntime();

const withTestCtx = Effect.fn(function* (
  options: Parameters<(typeof TestVsCode)["make"]>[0] = {},
) {
  const vscode = yield* TestVsCode.make(options);
  const layer = Layer.empty.pipe(
    Layer.merge(CellExecutions.layer),
    Layer.provideMerge(NotebookDocumentSessions.layer),
    Layer.provide(TestNotebookRuntime),
    Layer.provide(TestTelemetryLive),
    Layer.provideMerge(vscode.layer),
  );
  return { vscode, layer };
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

describe("NotebookExecutions", () => {
  const openNotebook = Effect.fn(function* (
    executions: Context.Service.Shape<typeof CellExecutions>,
    document: vscode.NotebookDocument,
    getDrive = Effect.succeed(Option.none<Drive>()),
  ) {
    yield* Effect.yieldNow;
    const sessions = yield* NotebookDocumentSessions;
    const session = sessions.forDocument(document);
    if (Option.isNone(session)) {
      return yield* Effect.die("Expected an open notebook document session");
    }
    const notebook = yield* executions
      .open(session.value, {
        getDrive,
      })
      .pipe(Effect.orDie);
    return { notebook, session: session.value };
  });

  const acknowledgeSubmission = Effect.fn(function* (
    notebook: NotebookExecutions,
    cellId: NotebookCellId,
    source: string,
    runId: string,
  ) {
    yield* notebook.submit([{ cellId, source }], Effect.succeed(undefined));
    yield* notebook.apply({
      op: "cell-op",
      cell_id: cellId,
      status: "queued",
      run_id: runId,
    });
  });

  it.effect(
    "keeps presentation commands on the drive that opened their run",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
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
        const events: string[] = [];
        const presented = yield* Latch.make();
        const namedDrive =
          (name: string): Drive =>
          (_cell, command) =>
            Effect.gen(function* () {
              if ("runId" in command) {
                events.push(`${name}:${command._tag}:${command.runId}`);
              }
              if (
                name === "second" &&
                command._tag === "RenderOutputs" &&
                command.runId === runId("run-2")
              ) {
                yield* presented.open;
              }
            });
        const first = namedDrive("first");
        const second = namedDrive("second");
        const currentDrive = yield* Ref.make(Option.some(first));
        const { notebook } = yield* openNotebook(
          executions,
          editor.notebook,
          Ref.get(currentDrive),
        );
        const id = Option.getOrThrow(
          MarimoNotebookDocument.from(editor.notebook).cellAt(0).id,
        );

        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "queued",
          run_id: "run-1",
        });
        yield* Ref.set(currentDrive, Option.some(second));
        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "queued",
          run_id: "run-2",
        });
        yield* Ref.set(currentDrive, Option.some(first));
        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "running",
        });
        yield* presented.await;

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
    "folds every operation while conflating pending output presentation",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
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
        const projectionStarted = yield* Latch.make();
        const releaseProjection = yield* Latch.make();
        const latestClosed = yield* Latch.make();
        const events: Array<{
          readonly label: string;
          readonly console: ReadonlyArray<unknown>;
        }> = [];
        const drive: Drive = (_cell, command) =>
          Effect.gen(function* () {
            const runIdSuffix = "runId" in command ? `:${command.runId}` : "";
            events.push({
              label: `${command._tag}${runIdSuffix}`,
              console:
                command._tag === "RenderOutputs"
                  ? command.state.consoleOutputs.map((output) => output.data)
                  : [],
            });
            if (
              command._tag === "RenderOutputs" &&
              command.runId === runId("run-1") &&
              !command.final
            ) {
              yield* projectionStarted.open;
              yield* releaseProjection.await;
            }
            if (
              command._tag === "CloseRun" &&
              command.runId === runId("run-2")
            ) {
              yield* latestClosed.open;
            }
          });
        const { notebook } = yield* openNotebook(
          executions,
          editor.notebook,
          Effect.succeed(Option.some(drive)),
        );
        const id = Option.getOrThrow(
          MarimoNotebookDocument.from(editor.notebook).cellAt(0).id,
        );

        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "queued",
          run_id: "run-1",
        });
        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "running",
          run_id: "run-1",
          console: {
            mimetype: "text/plain",
            channel: "stdout",
            data: "first",
            timestamp: 0,
          },
        });
        yield* projectionStarted.await;

        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "idle",
          run_id: "run-1",
        });
        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "queued",
          run_id: "run-2",
        });
        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "running",
          run_id: "run-2",
          console: {
            mimetype: "text/plain",
            channel: "stdout",
            data: "run-2-start",
            timestamp: 0,
          },
        });
        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          run_id: "run-2",
          console: {
            mimetype: "text/plain",
            channel: "stdout",
            data: "middle",
            timestamp: 0,
          },
        });
        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "idle",
          run_id: "run-2",
          console: {
            mimetype: "text/plain",
            channel: "stdout",
            data: "latest",
            timestamp: 0,
          },
        });

        yield* releaseProjection.open;
        yield* latestClosed.await;

        expect(events.map((event) => event.label)).toEqual([
          "SetDiagnostic",
          "OpenRun:run-1",
          "StartRun:run-1",
          "RenderOutputs:run-1",
          "SetDiagnostic",
          "CloseRun:run-1",
          "SetDiagnostic",
          "OpenRun:run-2",
          "StartRun:run-2",
          "RenderOutputs:run-2",
          "SetDiagnostic",
          "CloseRun:run-2",
        ]);
        expect(
          events.filter((event) => event.label.startsWith("RenderOutputs")),
        ).toEqual([
          { label: "RenderOutputs:run-1", console: ["first"] },
          {
            label: "RenderOutputs:run-2",
            console: ["firstrun-2-startmiddlelatest"],
          },
        ]);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "presents terminal output followed by a state-only trailer",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
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
        const projectionStarted = yield* Latch.make();
        const releaseProjection = yield* Latch.make();
        const runClosed = yield* Latch.make();
        const rendered: unknown[] = [];
        const drive: Drive = (_cell, command) =>
          Effect.gen(function* () {
            if (command._tag === "RenderOutputs") {
              rendered.push(command.state.output?.data);
              if (!command.final) {
                yield* projectionStarted.open;
                yield* releaseProjection.await;
              }
            }
            if (command._tag === "CloseRun") yield* runClosed.open;
          });
        const { notebook } = yield* openNotebook(
          executions,
          editor.notebook,
          Effect.succeed(Option.some(drive)),
        );
        const id = Option.getOrThrow(
          MarimoNotebookDocument.from(editor.notebook).cellAt(0).id,
        );

        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "queued",
          run_id: "run-1",
        });
        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "running",
          run_id: "run-1",
        });
        yield* projectionStarted.await;

        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "idle",
          run_id: "run-1",
          output: {
            mimetype: "text/plain",
            channel: "output",
            data: "42",
            timestamp: 0,
          },
        });
        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          serialization: "serialization",
        });

        yield* releaseProjection.open;
        yield* runClosed.await;

        expect(rendered).toEqual([undefined, "42"]);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "removing a cell closes its active presented run",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
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
        const events: string[] = [];
        const removed = yield* Latch.make();
        const drive: Drive = (_cell, command) =>
          Effect.gen(function* () {
            if ("runId" in command) {
              events.push(`${command._tag}:${command.runId}`);
            }
            if (command._tag === "CloseRun") yield* removed.open;
          });
        const { notebook } = yield* openNotebook(
          executions,
          editor.notebook,
          Effect.succeed(Option.some(drive)),
        );
        const id = Option.getOrThrow(
          MarimoNotebookDocument.from(editor.notebook).cellAt(0).id,
        );

        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "queued",
          run_id: "run-1",
        });
        yield* notebook.remove(id);
        yield* removed.await;

        expect(events).toEqual(["OpenRun:run-1", "CloseRun:run-1"]);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "keeps the source submitted before a delayed queued acknowledgement",
    Effect.fn(function* () {
      const cellData = {
        kind: 1,
        value: "x = 1",
        languageId: "python",
        metadata: MarimoNotebookCell.createMetadata({
          marimoRuntime: { stableId: "cell-1" },
        }),
      };
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
        data: { cells: [cellData] },
      });
      const ctx = yield* withTestCtx({ initialDocuments: [editor.notebook] });

      yield* Effect.gen(function* () {
        const executions = yield* CellExecutions;
        const { notebook } = yield* openNotebook(executions, editor.notebook);
        const cell = MarimoNotebookDocument.from(editor.notebook).cellAt(0);
        const id = Option.getOrThrow(cell.id);

        yield* notebook.submit(
          [{ cellId: id, source: "x = 1" }],
          Effect.succeed(null),
        );

        // The editor moves ahead before the kernel acknowledges the submission.
        const becomesStale = yield* notebook.staleCells.changes.pipe(
          Stream.filter((stale) => HashSet.has(stale, id)),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        cellData.value = "x = 2";
        yield* ctx.vscode.notebookChange({
          notebook: editor.notebook,
          metadata: undefined,
          cellChanges: [
            {
              cell: editor.notebook.cellAt(0),
              document: editor.notebook.cellAt(0).document,
              metadata: undefined,
              outputs: [],
              executionSummary: undefined,
            },
          ],
          contentChanges: [],
        });
        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "queued",
          run_id: "run-1",
        });

        expect(Option.isSome(yield* Fiber.join(becomesStale))).toBe(true);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "tracks sources for cells added after the notebook opens",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py");
      const addedCell = createNotebookCell(
        editor.notebook,
        {
          kind: 1,
          value: "x = 1",
          languageId: "python",
          metadata: MarimoNotebookCell.createMetadata({
            marimoRuntime: { stableId: "cell-1" },
          }),
        },
        0,
      );
      const id = Option.getOrThrow(MarimoNotebookCell.from(addedCell).id);
      const ctx = yield* withTestCtx({ initialDocuments: [editor.notebook] });

      yield* Effect.gen(function* () {
        const executions = yield* CellExecutions;
        const { notebook } = yield* openNotebook(executions, editor.notebook);
        const becomesStale = yield* notebook.staleCells.changes.pipe(
          Stream.filter((stale) => HashSet.has(stale, id)),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* ctx.vscode.notebookChange({
          notebook: editor.notebook,
          metadata: undefined,
          cellChanges: [],
          contentChanges: [
            {
              range: new NotebookRange(0, 0),
              removedCells: [],
              addedCells: [addedCell],
            },
          ],
        });
        yield* acknowledgeSubmission(notebook, id, "x = 1", "run-1");
        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "idle",
          run_id: "run-1",
          stale_inputs: true,
        });

        expect(Option.isSome(yield* Fiber.join(becomesStale))).toBe(true);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "accepts the current source when a cascaded cell queues without submission",
    Effect.fn(function* () {
      const cellData = {
        kind: 1,
        value: "x = 1",
        languageId: "python",
        metadata: MarimoNotebookCell.createMetadata({
          marimoRuntime: { stableId: "cell-1" },
        }),
      };
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
        data: { cells: [cellData] },
      });
      const ctx = yield* withTestCtx({ initialDocuments: [editor.notebook] });

      yield* Effect.gen(function* () {
        const executions = yield* CellExecutions;
        const { notebook } = yield* openNotebook(executions, editor.notebook);
        const id = Option.getOrThrow(
          MarimoNotebookDocument.from(editor.notebook).cellAt(0).id,
        );

        yield* acknowledgeSubmission(notebook, id, "x = 1", "run-1");
        cellData.value = "x = 2";
        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "queued",
          run_id: "run-2",
        });

        expect(HashSet.has(yield* notebook.staleCells.current, id)).toBe(false);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "derives staleness from the accepted submission and clears it on undo",
    Effect.fn(function* () {
      const cellData = {
        kind: 1,
        value: "x = 1",
        languageId: "python",
        metadata: MarimoNotebookCell.createMetadata({
          marimoRuntime: { stableId: "cell-1" },
        }),
      };
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
        data: { cells: [cellData] },
      });
      const ctx = yield* withTestCtx({ initialDocuments: [editor.notebook] });

      yield* Effect.gen(function* () {
        const executions = yield* CellExecutions;
        const { notebook } = yield* openNotebook(executions, editor.notebook);
        const id = Option.getOrThrow(
          MarimoNotebookDocument.from(editor.notebook).cellAt(0).id,
        );
        const notifyChange = () =>
          ctx.vscode.notebookChange({
            notebook: editor.notebook,
            metadata: undefined,
            cellChanges: [
              {
                cell: editor.notebook.cellAt(0),
                document: editor.notebook.cellAt(0).document,
                metadata: undefined,
                outputs: [],
                executionSummary: undefined,
              },
            ],
            contentChanges: [],
          });

        yield* Effect.yieldNow;
        expect(HashSet.has(yield* notebook.staleCells.current, id)).toBe(false);
        yield* acknowledgeSubmission(notebook, id, "x = 1", "run-1");

        const becomesStale = yield* notebook.staleCells.changes.pipe(
          Stream.filter((cells) => HashSet.has(cells, id)),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        cellData.value = "x = 2";
        yield* notifyChange();
        expect(Option.isSome(yield* Fiber.join(becomesStale))).toBe(true);

        const becomesCurrent = yield* notebook.staleCells.changes.pipe(
          Stream.filter((cells) => !HashSet.has(cells, id)),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        cellData.value = "x = 1";
        yield* notifyChange();
        expect(Option.isSome(yield* Fiber.join(becomesCurrent))).toBe(true);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "reads only changed cell sources when refreshing staleness",
    Effect.fn(function* () {
      const sources = Array.from({ length: 32 }, (_, index) => `x = ${index}`);
      const reads = sources.map(() => 0);
      const cells = sources.map(
        (_, index): vscode.NotebookCellData => ({
          kind: 1,
          get value() {
            reads[index] = (reads[index] ?? 0) + 1;
            return sources[index] ?? "";
          },
          set value(source: string) {
            sources[index] = source;
          },
          languageId: "python",
          metadata: MarimoNotebookCell.createMetadata({
            marimoRuntime: { stableId: `cell-${index}` },
          }),
        }),
      );
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
        data: { cells },
      });
      const ctx = yield* withTestCtx({ initialDocuments: [editor.notebook] });

      yield* Effect.gen(function* () {
        const executions = yield* CellExecutions;
        const { notebook } = yield* openNotebook(executions, editor.notebook);
        const id = Option.getOrThrow(
          MarimoNotebookDocument.from(editor.notebook).cellAt(0).id,
        );
        yield* acknowledgeSubmission(notebook, id, "x = 0", "run-1");
        reads.fill(0);

        const becomesStale = yield* notebook.staleCells.changes.pipe(
          Stream.filter((stale) => HashSet.has(stale, id)),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        sources[0] = "x = 100";
        yield* ctx.vscode.notebookChange({
          notebook: editor.notebook,
          metadata: undefined,
          cellChanges: [
            {
              cell: editor.notebook.cellAt(0),
              document: editor.notebook.cellAt(0).document,
              metadata: undefined,
              outputs: [],
              executionSummary: undefined,
            },
          ],
          contentChanges: [],
        });
        expect(Option.isSome(yield* Fiber.join(becomesStale))).toBe(true);

        expect(reads[0]).toBe(1);
        expect(reads.slice(1).every((count) => count === 0)).toBe(true);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "clears kernel invalidation when the cell is submitted again",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
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
        const { notebook } = yield* openNotebook(executions, editor.notebook);
        const id = Option.getOrThrow(
          MarimoNotebookDocument.from(editor.notebook).cellAt(0).id,
        );
        yield* acknowledgeSubmission(notebook, id, "x = 1", "run-1");
        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "idle",
          run_id: "run-1",
          stale_inputs: true,
        });
        expect(HashSet.has(yield* notebook.staleCells.current, id)).toBe(true);

        yield* acknowledgeSubmission(notebook, id, "x = 1", "run-2");
        expect(HashSet.has(yield* notebook.staleCells.current, id)).toBe(false);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "invalidates accepted sources without consulting an editor",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
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
        const commands: CellCommand[] = [];
        const invalidated = yield* Latch.make();
        const drive: Drive = (_cell, command) =>
          Effect.gen(function* () {
            commands.push(command);
            if (command._tag === "CloseRun") yield* invalidated.open;
          });
        const { notebook } = yield* openNotebook(
          executions,
          editor.notebook,
          Effect.succeed(Option.some(drive)),
        );
        const document = MarimoNotebookDocument.from(editor.notebook);
        const id = Option.getOrThrow(document.cellAt(0).id);

        yield* acknowledgeSubmission(notebook, id, "x = 1", "run-1");
        expect(HashSet.has(yield* notebook.staleCells.current, id)).toBe(false);

        yield* executions.invalidate(document.id);
        yield* invalidated.await;

        expect(HashSet.has(yield* notebook.staleCells.current, id)).toBe(true);
        expect(commands.at(-1)).toEqual(
          CellCommand.CloseRun({
            runId: runId("run-1"),
            success: false,
            at: Option.none(),
          }),
        );
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "forgets a never-run cell's source when the cell is removed",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
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
        const { notebook } = yield* openNotebook(executions, editor.notebook);
        const id = Option.getOrThrow(
          MarimoNotebookDocument.from(editor.notebook).cellAt(0).id,
        );

        yield* notebook.remove(id);
        yield* acknowledgeSubmission(notebook, id, "x = 2", "run-1");

        expect(HashSet.has(yield* notebook.staleCells.current, id)).toBe(false);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "rolls back source provenance when submission fails",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
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
        const { notebook } = yield* openNotebook(executions, editor.notebook);
        const id = Option.getOrThrow(
          MarimoNotebookDocument.from(editor.notebook).cellAt(0).id,
        );
        yield* notebook
          .submit([{ cellId: id, source: "never sent" }], Effect.fail("no"))
          .pipe(Effect.ignore);
        yield* acknowledgeSubmission(notebook, id, "x = 1", "run-1");

        expect(HashSet.has(yield* notebook.staleCells.current, id)).toBe(false);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "acknowledges multiple submissions for one cell in order",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
        data: {
          cells: [
            {
              kind: 1,
              value: "x = 2",
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
        const { notebook } = yield* openNotebook(executions, editor.notebook);
        const id = Option.getOrThrow(
          MarimoNotebookDocument.from(editor.notebook).cellAt(0).id,
        );
        const firstStarted = yield* Latch.make();
        const secondStarted = yield* Latch.make();
        const release = yield* Latch.make();

        const first = yield* notebook
          .submit(
            [{ cellId: id, source: "x = 1" }],
            firstStarted.open.pipe(Effect.andThen(release.await)),
          )
          .pipe(Effect.forkChild);
        yield* firstStarted.await;
        const second = yield* notebook
          .submit(
            [{ cellId: id, source: "x = 2" }],
            secondStarted.open.pipe(Effect.andThen(release.await)),
          )
          .pipe(Effect.forkChild);
        yield* secondStarted.await;

        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "queued",
          run_id: "run-1",
        });
        expect(HashSet.has(yield* notebook.staleCells.current, id)).toBe(true);

        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "queued",
          run_id: "run-2",
        });
        expect(HashSet.has(yield* notebook.staleCells.current, id)).toBe(false);

        yield* release.open;
        yield* Fiber.join(first);
        yield* Fiber.join(second);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "rolls back one submission without disturbing a later submission",
    Effect.fn(function* () {
      const cellData = {
        kind: 1,
        value: "x = 3",
        languageId: "python",
        metadata: MarimoNotebookCell.createMetadata({
          marimoRuntime: { stableId: "cell-1" },
        }),
      };
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
        data: { cells: [cellData] },
      });
      const ctx = yield* withTestCtx({ initialDocuments: [editor.notebook] });

      yield* Effect.gen(function* () {
        const executions = yield* CellExecutions;
        const { notebook } = yield* openNotebook(executions, editor.notebook);
        const id = Option.getOrThrow(
          MarimoNotebookDocument.from(editor.notebook).cellAt(0).id,
        );
        const firstStarted = yield* Latch.make();
        const failFirst = yield* Latch.make();

        const first = yield* notebook
          .submit(
            [{ cellId: id, source: "x = 1" }],
            firstStarted.open.pipe(
              Effect.andThen(failFirst.await),
              Effect.andThen(Effect.fail("no")),
            ),
          )
          .pipe(Effect.ignore, Effect.forkChild);
        yield* firstStarted.await;
        yield* notebook.submit([{ cellId: id, source: "x = 2" }], Effect.void);
        yield* failFirst.open;
        yield* Fiber.join(first);

        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "queued",
          run_id: "run-1",
        });
        expect(HashSet.has(yield* notebook.staleCells.current, id)).toBe(true);

        cellData.value = "x = 2";
        yield* ctx.vscode.notebookChange({
          notebook: editor.notebook,
          metadata: undefined,
          cellChanges: [
            {
              cell: editor.notebook.cellAt(0),
              document: editor.notebook.cellAt(0).document,
              metadata: undefined,
              outputs: [],
              executionSummary: undefined,
            },
          ],
          contentChanges: [],
        });
        expect(HashSet.has(yield* notebook.staleCells.current, id)).toBe(false);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "drops source provenance when interrupted before queued",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
        data: {
          cells: [
            {
              kind: 1,
              value: "x = 2",
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
        const { notebook } = yield* openNotebook(executions, editor.notebook);
        const id = Option.getOrThrow(
          MarimoNotebookDocument.from(editor.notebook).cellAt(0).id,
        );

        yield* notebook.submit([{ cellId: id, source: "x = 1" }], Effect.void);
        yield* notebook.interrupt;
        yield* acknowledgeSubmission(notebook, id, "x = 2", "run-1");

        expect(HashSet.has(yield* notebook.staleCells.current, id)).toBe(false);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "drops source provenance when compilation fails before queued",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
        data: {
          cells: [
            {
              kind: 1,
              value: "x = 2",
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
        const { notebook } = yield* openNotebook(executions, editor.notebook);
        const id = Option.getOrThrow(
          MarimoNotebookDocument.from(editor.notebook).cellAt(0).id,
        );

        yield* notebook.submit(
          [{ cellId: id, source: "x = 1" }],
          notebook.apply({
            op: "cell-op",
            cell_id: id,
            status: "idle",
            output: {
              mimetype: "application/vnd.marimo+error",
              channel: "marimo-error",
              data: [{ type: "syntax", msg: "invalid syntax" }],
            },
          }),
        );
        yield* acknowledgeSubmission(notebook, id, "x = 2", "run-1");

        expect(HashSet.has(yield* notebook.staleCells.current, id)).toBe(false);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "emits the current stale set before later changes",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
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
        const { notebook } = yield* openNotebook(executions, editor.notebook);
        const id = Option.getOrThrow(
          MarimoNotebookDocument.from(editor.notebook).cellAt(0).id,
        );

        const snapshots = yield* notebook.staleCells.changes.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "idle",
          stale_inputs: true,
        });

        const values = Array.from(yield* Fiber.join(snapshots));
        expect(values).toHaveLength(2);
        expect(HashSet.size(values[0])).toBe(0);
        expect(HashSet.has(values[1], id)).toBe(true);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "rejects a tagged operation from an older run before mutation",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
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
        const { notebook } = yield* openNotebook(executions, editor.notebook);
        const id = Option.getOrThrow(
          MarimoNotebookDocument.from(editor.notebook).cellAt(0).id,
        );

        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "queued",
          run_id: "run-1",
        });
        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "queued",
          run_id: "run-2",
        });

        const error = yield* notebook
          .apply({
            op: "cell-op",
            cell_id: id,
            status: "running",
            run_id: "run-1",
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("RunCorrelationError");
        expect(error.expectedRunId).toEqual(Option.some(runId("run-2")));
        expect(error.receivedRunId).toEqual(Option.some(runId("run-1")));
        expect(error.reason).toBe("superseded-run");
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "keeps the state fold from a rejected operation for the final render",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
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
        const finalRenders: CellRuntimeState[] = [];
        const rendered = yield* Latch.make();
        const drive: Drive = (_cell, command) =>
          Effect.gen(function* () {
            if (command._tag === "RenderOutputs" && command.final) {
              finalRenders.push(command.state);
              yield* rendered.open;
            }
          });
        const { notebook } = yield* openNotebook(
          executions,
          editor.notebook,
          Effect.succeed(Option.some(drive)),
        );
        const id = Option.getOrThrow(
          MarimoNotebookDocument.from(editor.notebook).cellAt(0).id,
        );

        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "queued",
          run_id: "run-2",
        });
        // A console append from a thread of a previous run: the command is
        // rejected, but the kernel's state fold must survive.
        const error = yield* notebook
          .apply({
            op: "cell-op",
            cell_id: id,
            run_id: "run-1",
            console: {
              mimetype: "text/plain",
              channel: "stdout",
              data: "late line",
              timestamp: 0,
            },
          })
          .pipe(Effect.flip);
        expect(error._tag).toBe("RunCorrelationError");

        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "running",
        });
        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "idle",
        });
        yield* rendered.await;

        expect(finalRenders).toHaveLength(1);
        expect(
          finalRenders[0]?.consoleOutputs.map((output) => output.data),
        ).toContain("late line");
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "retains downstream staleness tagged with an ancestor run",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
        data: {
          cells: [
            {
              kind: 1,
              value: "x = 1",
              languageId: "python",
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "ancestor" },
              }),
            },
            {
              kind: 1,
              value: "y = x + 1",
              languageId: "python",
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "descendant" },
              }),
            },
          ],
        },
      });
      const ctx = yield* withTestCtx({ initialDocuments: [editor.notebook] });

      yield* Effect.gen(function* () {
        const executions = yield* CellExecutions;
        const { notebook } = yield* openNotebook(executions, editor.notebook);
        const document = MarimoNotebookDocument.from(editor.notebook);
        const ancestorId = Option.getOrThrow(document.cellAt(0).id);
        const descendantId = Option.getOrThrow(document.cellAt(1).id);

        yield* acknowledgeSubmission(
          notebook,
          descendantId,
          "y = x + 1",
          "initial-run",
        );
        yield* notebook.apply({
          op: "cell-op",
          cell_id: descendantId,
          status: "idle",
          run_id: "initial-run",
        });
        yield* notebook.apply({
          op: "cell-op",
          cell_id: ancestorId,
          status: "queued",
          run_id: "ancestor-run",
        });

        // Lazy execution tags every notification in the cascade with the
        // ancestor's run ID, including stale-only updates for idle descendants.
        yield* notebook.apply({
          op: "cell-op",
          cell_id: descendantId,
          status: null,
          run_id: "ancestor-run",
          stale_inputs: true,
        });

        expect(
          HashSet.has(yield* notebook.staleCells.current, descendantId),
        ).toBe(true);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "rejects a tagged operation after its run completes",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
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
        let opened = 0;
        const runOpened = yield* Latch.make();
        const drive: Drive = (_cell, command) =>
          Effect.gen(function* () {
            if (command._tag === "OpenRun") {
              opened += 1;
              yield* runOpened.open;
            }
          });
        const { notebook } = yield* openNotebook(
          executions,
          editor.notebook,
          Effect.succeed(Option.some(drive)),
        );
        const id = Option.getOrThrow(
          MarimoNotebookDocument.from(editor.notebook).cellAt(0).id,
        );

        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "queued",
          run_id: "run-1",
        });
        yield* notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "idle",
          run_id: "run-1",
        });
        yield* runOpened.await;
        expect(opened).toBe(1);

        const error = yield* notebook
          .apply({
            op: "cell-op",
            cell_id: id,
            status: "idle",
            run_id: "run-1",
            output: {
              mimetype: "application/vnd.marimo+error",
              channel: "marimo-error",
              data: [{ type: "syntax", msg: "late error" }],
            },
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("RunCorrelationError");
        expect(error.expectedRunId).toEqual(Option.none());
        expect(error.receivedRunId).toEqual(Option.some(runId("run-1")));
        expect(opened).toBe(1);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "an old document session cannot evict its replacement",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py", {
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
        const first = yield* openNotebook(executions, editor.notebook);
        const replacement = TestVsCode.makeNotebookEditor(editor.notebook.uri, {
          data: {
            cells: [
              {
                kind: 1,
                value: "x = 2",
                languageId: "python",
                metadata: MarimoNotebookCell.createMetadata({
                  marimoRuntime: { stableId: "cell-1" },
                }),
              },
            ],
          },
        });
        yield* ctx.vscode.openNotebook(replacement.notebook);
        yield* Effect.yieldNow;
        const second = yield* openNotebook(executions, replacement.notebook);
        const id = Option.getOrThrow(
          MarimoNotebookDocument.from(replacement.notebook).cellAt(0).id,
        );

        const error = yield* executions
          .open(first.session, { getDrive: Effect.succeed(Option.none()) })
          .pipe(Effect.flip);
        expect(error._tag).toBe("NotebookDocumentSessionEndedError");

        yield* ctx.vscode.closeNotebook(editor.notebook);
        yield* Effect.yieldNow;

        yield* second.notebook.apply({
          op: "cell-op",
          cell_id: id,
          status: "queued",
          run_id: "replacement-run",
        });

        expect(executions.find(replacement.notebook)).toEqual(
          Option.some(second.notebook),
        );
      }).pipe(Effect.provide(ctx.layer));
    }),
  );
});
