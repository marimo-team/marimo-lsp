import {
  Array as EffectArray,
  Chunk,
  Effect,
  Layer,
  Option,
  Runtime,
  Stream,
  Inspectable,
  Schema,
} from "effect";

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
  if (op.console == null) {
    return "";
  }
  return EffectArray.ensure(op.console)
    .filter(
      (output) =>
        output != null &&
        (output.channel === "stdout" || output.channel === "stderr"),
    )
    .map((output) =>
      typeof output.data === "string"
        ? output.data
        : Inspectable.format(output.data),
    )
    .join("");
}

export const ExecuteCodeInput = Schema.Struct({
  /** URI of the marimo notebook whose kernel to run in (explicit, no default). */
  notebookUri: Schema.String,
  /** Python to run in that notebook's live kernel (scratchpad). */
  code: Schema.String,
});
/**
 * The marimo-pair skill always reaches code mode through this shape:
 *
 *     import marimo._code_mode as cm
 *     async with cm.get_context() as ctx:
 *         ctx.create_cell(...)
 *
 * Verb detection is anchored to the variable bound by `as <name>:` so we only
 * match calls on the actual context object — `ctx.run_cell(...)`, not some
 * unrelated object that happens to expose `.run_cell(`. Returns the bound names
 * (usually one), or `null` if the code doesn't engage code mode at all, in
 * which case the spinner stays on the generic kernel message.
 */
const codeModeContextNames = (code: string): ReadonlyArray<string> | null => {
  if (!/marimo\._code_mode|\.\s*get_context\s*\(/.test(code)) return null;
  const names = new Set<string>();
  const re = /\bget_context\s*\([^)]*\)\s+as\s+([A-Za-z_]\w*)/g;
  for (const match of code.matchAll(re)) names.add(match[1]);
  return names.size === 0 ? null : [...names];
};

/**
 * Short summary of what an `execute_code` call is doing, for the invocation
 * spinner. Recognized code-mode cell mutations collapse to a single structural
 * verb (a mix, or any edit, reads as "Editing") and fold in cell runs to read
 * like a sentence — e.g. "Editing and running cells". Package ops get their
 * own phrase, and plain scratchpad runs fall back to the kernel message.
 */
const summarizeExecution = (code: string): string => {
  const fallback = "Running code in the marimo kernel";

  const ctxNames = codeModeContextNames(code);
  if (ctxNames === null) return fallback;

  // `ctx.create_cell(`, allowing whitespace, for any bound context name.
  const calls = (method: string): RegExp =>
    new RegExp(
      `\\b(?:${ctxNames.join("|")})\\s*\\.\\s*${method}\\s*\\(`,
    );

  const create = calls("create_cell").test(code);
  const edit = calls("edit_cell").test(code);
  const del = calls("delete_cell").test(code);
  const move = calls("move_cell").test(code);
  const run = calls("run_cell").test(code);

  // Pick one structural verb. A single kind names itself; any mix (or an
  // explicit edit) reads as the catch-all "Editing".
  const structural = (() => {
    const kinds = [create, edit, del, move].filter(Boolean).length;
    if (kinds === 0) return null;
    if (kinds > 1 || edit) return "Editing";
    if (create) return "Creating";
    if (del) return "Deleting";
    return "Moving";
  })();

  if (structural) {
    return run ? `${structural} and running cells` : `${structural} cells`;
  }
  if (run) return "Running cells";

  const pkgAdd = calls("packages\\s*\\.\\s*add").test(code);
  const pkgRemove = calls("packages\\s*\\.\\s*remove").test(code);
  if (pkgAdd && pkgRemove) return "Updating packages";
  if (pkgAdd) return "Installing packages";
  if (pkgRemove) return "Removing packages";

  return fallback;
};

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

    /**
     * Resolve the explicit URI against open notebooks
     */
    const resolveNotebookId = Effect.fn(function* (
      input: typeof ExecuteCodeInput.Type,
    ) {
      const notebooks = yield* code.workspace.getNotebookDocuments();

      const first = EffectArray.findFirst(
        EffectArray.getSomes(
          notebooks.map((raw) => MarimoNotebookDocument.tryFrom(raw)),
        ),
        (notebook) => notebook.id === input.notebookUri,
      );

      return Option.map(first, (nb) => nb.id);
    });

    const result = (text: string) =>
      new code.LanguageModelToolResult([new code.LanguageModelTextPart(text)]);

    const executeCode = Effect.fn("lm.executeCode")(function* (
      unknownInput: unknown,
    ) {
      const input = yield* Schema.decodeUnknown(ExecuteCodeInput)(unknownInput);

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
      // any cells a code-mode cascade re-ran
      const [scratchOps, cascadeOps] = EffectArray.partition(
        Chunk.toReadonlyArray(ops),
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

      // Console from cascade cells, concatenated in arrival order
      const cascadeText = cascadeOps.map(consoleText).join("");

      const text = scratchText + cascadeText;

      return result(text.trim() === "" ? "(no output)" : text);
    });

    yield* code.lm.registerTool<unknown>(EXECUTE_CODE_TOOL, {
      prepareInvocation(options) {
        const input = Schema.decodeUnknownSync(ExecuteCodeInput)(options.input);
        return {
          invocationMessage: `${summarizeExecution(input.code)}…`,
          // Side-effecting (arbitrary code in the user's kernel) — confirm.
          confirmationMessages: {
            title: "Run code in the marimo kernel?",
            message: new code.MarkdownString(
              `\`\`\`python\n${input.code}\n\`\`\``,
            ),
          },
        };
      },
      invoke(options, token) {
        return runPromise(executeCode(options.input), {
          signal: signalFromToken(token),
        });
      },
    });
  }),
);
