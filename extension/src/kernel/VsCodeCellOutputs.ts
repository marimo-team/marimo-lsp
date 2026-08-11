import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import type {
  CellOutput,
  OutputMessage,
} from "@marimo-team/frontend/unstable_internal/core/kernel/messages.ts";
import { Context, Option, Array as EffectArray } from "effect";
import type * as vscode from "vscode";

import { logUnreachable } from "../assert.ts";
import { SCRATCH_CELL_ID } from "../constants.ts";
import { prettyErrorMessage } from "../lib/errors.ts";
import {
  extractCellFrames,
  parseTraceback,
  type TracebackCellFrame,
} from "../lib/tracebacks.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  type NotebookCellId,
  MarimoNotebookDocument,
} from "../schemas/MarimoNotebookDocument.ts";
import {
  type CellOperationNotification,
  type CellRuntimeState,
  createCellNavigationLink,
} from "../types.ts";
import type { KeyedCellOutput } from "./CellOutputProjection.ts";
import { transitionCell } from "./CellRunReducer.ts";

type VsCodeService = Context.Service.Shape<typeof VsCode>;

/** Convert scratch-cell notifications to one VS Code output. */
export function scratchCellNotificationsToVsCodeOutput(
  notifications:
    | CellOperationNotification
    | ReadonlyArray<CellOperationNotification>,
  code: VsCodeService,
) {
  const arr = EffectArray.ensure(notifications);
  const outputs = buildCellOutputs(
    SCRATCH_CELL_ID,
    arr.reduce(transitionCell, createCellRuntimeState()),
    code,
  );
  const items = outputs.flatMap((output) => output.items);
  return items.length === 0
    ? Option.none<vscode.NotebookCellOutput>()
    : Option.some(new code.NotebookCellOutput(items));
}

/** Build VS Code cell outputs grouped by their logical output channel. */
export function buildCellOutputs(
  cellId: NotebookCellId,
  state: CellRuntimeState,
  code: VsCodeService,
  notebook?: vscode.NotebookDocument,
): vscode.NotebookCellOutput[] {
  return buildKeyedCellOutputs(cellId, state, code, notebook).map(
    (keyed) => keyed.output,
  );
}

/**
 * Build outputs with stable keys used by {@link CellOutputProjection}.
 * Console streams arrive before the main result, matching Jupyter ordering.
 */
export function buildKeyedCellOutputs(
  cellId: NotebookCellId,
  state: CellRuntimeState,
  code: VsCodeService,
  notebook?: vscode.NotebookDocument,
): KeyedCellOutput[] {
  const outputs: KeyedCellOutput[] = [];
  const stdoutItems: vscode.NotebookCellOutputItem[] = [];
  const stderrItems: vscode.NotebookCellOutputItem[] = [];
  const stdinItems: vscode.NotebookCellOutputItem[] = [];
  const errorItems: vscode.NotebookCellOutputItem[] = [];
  const outputItems: vscode.NotebookCellOutputItem[] = [];
  const tracebackItems: vscode.NotebookCellOutputItem[] = [];

  if (state.consoleOutputs) {
    for (const output of state.consoleOutputs) {
      const item = buildOutputItem(
        output,
        cellId,
        { ...state, output: null },
        code,
        notebook,
      );
      if (!item) continue;

      if (output.mimetype === TRACEBACK_MIME) {
        tracebackItems.push(item);
        continue;
      }

      switch (output.channel) {
        case "stdout":
          stdoutItems.push(item);
          break;
        case "stderr":
          stderrItems.push(item);
          break;
        case "stdin":
          stdinItems.push(item);
          break;
        case "media":
          stdoutItems.push(item);
          break;
        case "output":
        case "marimo-error":
        case "pdb":
          break;
        default:
          logUnreachable(output.channel);
      }
    }
  }

  if (state.output && !isOutputEmpty(state.output)) {
    const item = buildOutputItem(
      state.output,
      cellId,
      { ...state, consoleOutputs: [] },
      code,
      notebook,
    );
    if (item) {
      if (state.output.channel === "marimo-error") {
        errorItems.push(item);
      } else {
        outputItems.push(item);
      }
    }
  }

  if (stdoutItems.length > 0) {
    outputs.push({
      key: "stdout",
      output: new code.NotebookCellOutput(stdoutItems, { channel: "stdout" }),
    });
  }
  if (stderrItems.length > 0) {
    outputs.push({
      key: "stderr",
      output: new code.NotebookCellOutput(stderrItems, { channel: "stderr" }),
    });
  }

  const errorShown = errorItems.length > 0 && !shouldSuppressMarimoError(state);
  let mainSlotTaken = false;
  if (errorShown) {
    outputs.push({
      key: "main",
      output: new code.NotebookCellOutput(errorItems, {
        channel: "marimo-error",
      }),
    });
    mainSlotTaken = true;
  } else if (outputItems.length > 0) {
    outputs.push({
      key: "main",
      output: new code.NotebookCellOutput(outputItems),
    });
    mainSlotTaken = true;
  }

  tracebackItems.forEach((tracebackItem, index) => {
    const key = !mainSlotTaken && index === 0 ? "main" : `traceback:${index}`;
    if (key === "main") mainSlotTaken = true;
    outputs.push({
      key,
      output: new code.NotebookCellOutput([tracebackItem], {
        channel: "stderr",
      }),
    });
  });

  if (stdinItems.length > 0) {
    outputs.push({
      key: "stdin",
      output: new code.NotebookCellOutput(stdinItems, { channel: "stdin" }),
    });
  }

  return outputs;
}

const TRACEBACK_MIME = "application/vnd.marimo+traceback";

function hasTraceback(state: CellRuntimeState): boolean {
  if (state.output?.mimetype === TRACEBACK_MIME) return true;
  return (state.consoleOutputs ?? []).some(
    (output) => output?.mimetype === TRACEBACK_MIME,
  );
}

export function cellTracebackFrame(
  state: CellRuntimeState,
  cellId: NotebookCellId,
): TracebackCellFrame | undefined {
  const traceback = (state.consoleOutputs ?? []).find(
    (output) => output?.mimetype === TRACEBACK_MIME,
  );
  if (!traceback) return undefined;
  const text =
    typeof traceback.data === "object"
      ? JSON.stringify(traceback.data)
      : traceback.data;
  return extractCellFrames(text)
    .filter((frame) => frame.cellId === cellId)
    .at(-1);
}

export function diagnosticMessage(state: CellRuntimeState): string {
  const data = state.output?.data;
  return Array.isArray(data) && data.length > 0
    ? prettyErrorMessage(data[0])
    : "Cell execution failed";
}

function shouldSuppressMarimoError(state: CellRuntimeState): boolean {
  const output = state.output;
  if (
    !output ||
    output.channel !== "marimo-error" ||
    !Array.isArray(output.data)
  ) {
    return false;
  }
  const everyRedundant = output.data.every((error) => {
    if (error == null || typeof error !== "object") return false;
    if (!("type" in error) || error.type !== "exception") return false;
    return !("raising_cell" in error) || !error.raising_cell;
  });
  return everyRedundant && hasTraceback(state);
}

function createCellIdMapper(
  notebook: MarimoNotebookDocument,
): (cellId: NotebookCellId) => string | undefined {
  return (cellId) => {
    const cellIndex = notebook.getCells().findIndex((cell) =>
      Option.match(cell.id, {
        onSome: (id) => id === cellId,
        onNone: () => false,
      }),
    );
    return cellIndex === -1
      ? undefined
      : createCellNavigationLink(cellId, cellIndex + 1);
  };
}

function createCellIdToIndex(
  notebook: MarimoNotebookDocument,
): (cellId: string) => number | undefined {
  return (cellId) => {
    const cellIndex = notebook.getCells().findIndex((cell) =>
      Option.match(cell.id, {
        onSome: (id) => id === cellId,
        onNone: () => false,
      }),
    );
    return cellIndex === -1 ? undefined : cellIndex;
  };
}

function buildOutputItem(
  output: CellOutput,
  cellId: NotebookCellId,
  state: CellRuntimeState,
  code: VsCodeService,
  notebook?: vscode.NotebookDocument,
): vscode.NotebookCellOutputItem | null {
  if (output.mimetype === "text/plain") {
    const text =
      typeof output.data === "object"
        ? JSON.stringify(output.data)
        : // oxlint-disable-next-line typescript-eslint/no-unnecessary-type-conversion
          String(output.data);
    if (!text) return null;
    switch (output.channel) {
      case "stdout":
        return code.NotebookCellOutputItem.stdout(text);
      case "stderr":
        return code.NotebookCellOutputItem.stderr(text);
      case "stdin":
        return code.NotebookCellOutputItem.text(text, "text/plain");
    }
  }

  if (output.mimetype === TRACEBACK_MIME) {
    const text =
      typeof output.data === "object"
        ? JSON.stringify(output.data)
        : // oxlint-disable-next-line typescript-eslint/no-unnecessary-type-conversion
          String(output.data);
    if (!text) return null;
    const cellIdToIndex = notebook
      ? createCellIdToIndex(MarimoNotebookDocument.from(notebook))
      : undefined;
    return code.NotebookCellOutputItem.error(
      parseTraceback(text, cellIdToIndex),
    );
  }

  if (output.channel === "marimo-error" && Array.isArray(output.data)) {
    const cellIdMapper = notebook
      ? createCellIdMapper(MarimoNotebookDocument.from(notebook))
      : undefined;
    const errors = output.data.map((error) => {
      const message = prettyErrorMessage(error, cellIdMapper);
      return message.includes("<a href=")
        ? code.NotebookCellOutputItem.text(message, "text/html")
        : code.NotebookCellOutputItem.stderr(message);
    });
    return errors[0] || null;
  }

  if (isOutputEmpty(output)) return null;
  return code.NotebookCellOutputItem.json(
    { cellId, state },
    "application/vnd.marimo.ui+json",
  );
}

function isOutputEmpty(output: OutputMessage | undefined | null): boolean {
  return output == null || output.data == null || output.data === "";
}
