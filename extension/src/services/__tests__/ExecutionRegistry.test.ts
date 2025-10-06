import { expect, it } from "@effect/vitest";
import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import { Effect } from "effect";
import { TestVsCodeLive } from "../../__mocks__/TestVsCode.ts";
import type { CellRuntimeState } from "../../types.ts";
import { VsCode } from "../VsCode.ts";
import { buildCellOutputs, NotebookCellId } from "../ExecutionRegistry.ts";

const ExecutionRegistryTestLive = TestVsCodeLive;

const CELL_ID = "test-cell-id" as NotebookCellId;

// Convert Uint8Array data to strings for readable snapshots
function normalizeOutputsForSnapshot(outputs: unknown) {
  if (!Array.isArray(outputs)) return outputs;

  return outputs.map((output: any) => {
    if (!output.items) return output;

    return {
      ...output,
      items: output.items.map((item: any) => {
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

it.layer(ExecutionRegistryTestLive)("buildCellOutputs", (it) => {
  it.effect(
    "handles stdout output",
    Effect.fnUntraced(function* () {
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

      const outputs = buildCellOutputs(
        CELL_ID,
        state,
        code,
      );

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles stderr output",
    Effect.fnUntraced(function* () {
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

      const outputs = buildCellOutputs(
        CELL_ID,
        state,
        code,
      );

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles multiple console outputs",
    Effect.fnUntraced(function* () {
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

      const outputs = buildCellOutputs(
        CELL_ID,
        state,
        code,
      );

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles marimo error output",
    Effect.fnUntraced(function* () {
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

      const outputs = buildCellOutputs(
        CELL_ID,
        state,
        code,
      );

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles HTML output",
    Effect.fnUntraced(function* () {
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

      const outputs = buildCellOutputs(
        CELL_ID,
        state,
        code,
      );

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles JSON output",
    Effect.fnUntraced(function* () {
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

      const outputs = buildCellOutputs(
        CELL_ID,
        state,
        code,
      );

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles mixed output and console streams",
    Effect.fnUntraced(function* () {
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

      const outputs = buildCellOutputs(
        CELL_ID,
        state,
        code,
      );

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles stdin output",
    Effect.fnUntraced(function* () {
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

      const outputs = buildCellOutputs(
        CELL_ID,
        state,
        code,
      );

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles empty state",
    Effect.fnUntraced(function* () {
      const code = yield* VsCode;
      const state: CellRuntimeState = createCellRuntimeState();

      const outputs = buildCellOutputs(
        CELL_ID,
        state,
        code,
      );

      // Should still have the marimo UI output
      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles multiple errors in marimo error output",
    Effect.fnUntraced(function* () {
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

      const outputs = buildCellOutputs(
        CELL_ID,
        state,
        code,
      );

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles multiple stderr errors",
    Effect.fnUntraced(function* () {
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

      const outputs = buildCellOutputs(
        CELL_ID,
        state,
        code,
      );

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles stdout + stderr + output together",
    Effect.fnUntraced(function* () {
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

      const outputs = buildCellOutputs(
        CELL_ID,
        state,
        code,
      );

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );

  it.effect(
    "handles application/vnd.marimo+traceback output",
    Effect.fnUntraced(function* () {
      const code = yield* VsCode;
      const state: CellRuntimeState = {
        ...createCellRuntimeState(),
        output: {
          mimetype: "application/vnd.marimo+traceback",
          channel: "output",
          data: "<b>Traceback (most recent call last):</b>\n  File \"<stdin>\", line 1, in <module>\nTypeError: invalid value",
        },
      };

      const outputs = buildCellOutputs(
        CELL_ID,
        state,
        code,
      );

      expect(normalizeOutputsForSnapshot(outputs)).toMatchSnapshot();
    }),
  );
});

