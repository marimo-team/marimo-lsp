import {
  Array as ReadonlyArray,
  Chunk,
  Effect,
  Layer,
  Option,
  Runtime,
  Stream,
} from "effect";
import type * as vscode from "vscode";

import { SCRATCH_CELL_ID } from "../constants.ts";
import { scratchCellNotificationsToVsCodeOutput } from "../kernel/ExecutionRegistry.ts";
import { KernelManager } from "../kernel/KernelManager.ts";
import { signalFromToken } from "../lib/signalFromToken.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  extractCellIdFromCellMessage,
  MarimoNotebookDocument,
} from "../schemas/MarimoNotebookDocument.ts";
import type { CellOperationNotification } from "../types.ts";

/**
 * The agent-facing tool name. Mirrors the `contributes.languageModelTools`
 * entry in package.json — VS Code requires both to match.
 */
const EXECUTE_CODE_TOOL = "marimo_executeCode";

/**
 * Extract a cell-op's stdout/stderr text
 *
 * Read the notification's `console` delta and concatenate each stdout/stderr
 * output's `data`. Other channels (stdin, pdb, media) are skipped, matching
 * marimo's /api/kernel/execute SSE endpoint.
 */
export function consoleText(op: CellOperationNotification): string {
  const { console } = op;
  if (console == null) {
    return "";
  }
  const outputs = Array.isArray(console) ? console : [console];
  return outputs
    .filter(
      (output) =>
        output != null &&
        (output.channel === "stdout" || output.channel === "stderr"),
    )
    .map((output) =>
      typeof output.data === "string"
        ? output.data
        : JSON.stringify(output.data),
    )
    .join("");
}

interface ExecuteCodeInput {
  /** URI of the marimo notebook whose kernel to run in (explicit, no default). */
  readonly notebookUri: string;
  /** Python to run in that notebook's live kernel (scratchpad). */
  readonly code: string;
}

/**
 * Registers the `execute_code` Language Model Tool: the single channel an agent
 * uses to run Python in a marimo notebook's kernel. Exploration stays in the
 * scratchpad; durable edits happen when the agent's code uses
 * `marimo._code_mode` (taught by the marimo-pair skill). The tool's output is
 * the scratch run's text (stdout/result + code mode's summary).
 */
export const RegisterLanguageModelToolsLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const kernelManager = yield* KernelManager;
    const runPromise = Runtime.runPromise(yield* Effect.runtime());
    const decoder = new TextDecoder();

    // Resolve the explicit URI against open notebooks (validates it's a live
    // marimo notebook and yields the canonical id the kernel is keyed by).
    const resolveNotebookId = Effect.fn(function* (input: ExecuteCodeInput) {
      const notebooks = yield* code.workspace.getNotebookDocuments();
      return ReadonlyArray.findFirst(
        ReadonlyArray.getSomes(
          notebooks.map((raw) => MarimoNotebookDocument.tryFrom(raw)),
        ),
        (notebook) => notebook.id === input.notebookUri,
      ).pipe(Option.map((notebook) => notebook.id));
    });

    const result = (text: string) =>
      new code.LanguageModelToolResult([new code.LanguageModelTextPart(text)]);

    const executeCode = Effect.fn("lm.executeCode")(function* (
      input: ExecuteCodeInput,
    ) {
      const notebookId = yield* resolveNotebookId(input);
      if (Option.isNone(notebookId)) {
        return result(
          `No open marimo notebook matches \`${input.notebookUri}\`.`,
        );
      }

      const ops = yield* kernelManager
        .executeCodeUnsafe(notebookId.value, input.code)
        .pipe(Stream.runCollect);

      // Mirror marimo's SSE `/execute` endpoint (`ScratchCellListener.stream`):
      // surface the scratch cell's own output PLUS console (stdout/stderr) from
      // any cells a code-mode cascade re-ran, so the agent sees downstream
      // output (e.g. a re-run `print`) without reading the notebook.
      const allOps = Chunk.toReadonlyArray(ops);
      const scratchOps = allOps.filter(
        (op) => extractCellIdFromCellMessage(op) === SCRATCH_CELL_ID,
      );

      // The scratch cell's own output (its console + rendered value).
      const scratchText = scratchCellNotificationsToVsCodeOutput(
        scratchOps,
        code,
      ).pipe(
        Option.map((cellOutput) =>
          cellOutput.items.map((item) => decoder.decode(item.data)).join(""),
        ),
        Option.getOrElse(() => ""),
      );

      // Console from cascade cells, concatenated in arrival order — exactly
      // what SSE's `_format_console` does: read each notification's `console`
      // delta and emit its stdout/stderr `data`. No reduce/grouping; the kernel
      // streams console incrementally and the cascade cells' rendered output
      // lives in the notebook, not here.
      const cascadeText = allOps
        .filter((op) => extractCellIdFromCellMessage(op) !== SCRATCH_CELL_ID)
        .map(consoleText)
        .join("");

      const text = scratchText + cascadeText;

      return result(text.trim() === "" ? "(no output)" : text);
    });

    const tool: vscode.LanguageModelTool<ExecuteCodeInput> = {
      prepareInvocation(options) {
        return {
          invocationMessage: "Running code in the marimo kernel…",
          // Side-effecting (arbitrary code in the user's kernel) — confirm.
          confirmationMessages: {
            title: "Run code in the marimo kernel?",
            message: new code.MarkdownString(
              `\`\`\`python\n${options.input.code}\n\`\`\``,
            ),
          },
        };
      },
      invoke(options, token) {
        return runPromise(executeCode(options.input), {
          signal: signalFromToken(token),
        });
      },
    };

    yield* code.lm.registerTool(EXECUTE_CODE_TOOL, tool);
  }),
);
