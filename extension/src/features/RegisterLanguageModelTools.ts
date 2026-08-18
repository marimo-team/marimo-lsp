import {
  Array as EffectArray,
  Context,
  Effect,
  Formatter,
  Layer,
  Option,
  Result,
  Stream,
  Schema,
} from "effect";

import { SCRATCH_CELL_ID } from "../constants.ts";
import { NotebookRuntime } from "../kernel/NotebookRuntime.ts";
import { scratchCellNotificationsToVsCodeOutput } from "../kernel/VsCodeCellOutputs.ts";
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

type VsCodeService = Context.Service.Shape<typeof VsCode>;

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
        : Formatter.format(output.data, { space: 2 }),
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
 * Render a scratchpad run as the text the agent sees.
 *
 * This is the same as the marimo SSE `/execute` endpoint. It gives the
 * output of the scratch cell first. Then it gives the console output of the
 * cells that a code mode cascade ran again.
 */
export function scratchpadResultText(
  ops: ReadonlyArray<CellOperationNotification>,
  code: VsCodeService,
  decoder = new TextDecoder(),
): string {
  // `partition` returns the excluded items first. The cascade ops are the
  // `Result.fail` arm.
  const [cascadeOps, scratchOps] = EffectArray.partition(ops, (op) =>
    extractCellIdFromCellMessage(op) === SCRATCH_CELL_ID
      ? Result.succeed(op)
      : Result.fail(op),
  );

  const scratchText = scratchCellNotificationsToVsCodeOutput(
    scratchOps,
    code,
  ).pipe(
    Option.map((cellOutput) =>
      cellOutput.items.map((item) => decoder.decode(item.data)).join(""),
    ),
    Option.getOrElse(() => ""),
  );

  return scratchText + cascadeOps.map(consoleText).join("");
}

/**
 * Registers the `execute_code` Language Model Tool: the single channel an agent
 * uses to run Python in a marimo notebook's kernel. Exploration stays in the
 * scratchpad; durable edits happen when the agent's code uses
 * `marimo._code_mode` (taught by the marimo-pair skill). The tool's output is
 * the scratch run's text (stdout/result + code mode's summary).
 */
export const RegisterLanguageModelToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const notebooks = yield* NotebookRuntime;
    const runPromise = Effect.runPromiseWith(yield* Effect.context());
    const decoder = new TextDecoder();

    /**
     * Resolve the explicit URI against open notebooks
     */
    const resolveNotebookId = Effect.fn(function* (
      input: typeof ExecuteCodeInput.Type,
    ) {
      const notebooks = yield* code.workspace.getNotebookDocuments;

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
      const input =
        yield* Schema.decodeUnknownEffect(ExecuteCodeInput)(unknownInput);

      const notebookId = yield* resolveNotebookId(input);
      if (Option.isNone(notebookId)) {
        return result(
          `No open marimo notebook matches \`${input.notebookUri}\`. ` +
            `Pass the URI of a marimo notebook open in VS Code's notebook editor. ` +
            `Do not fall back to editing the \`.py\` file with Edit/Write/NotebookEdit — ` +
            `that bypasses the live kernel.`,
        );
      }

      const notebook = yield* notebooks.forNotebook(notebookId.value);
      const ops = yield* notebook
        .executeScratchpad(input.code)
        .pipe(Stream.runCollect);

      const text = scratchpadResultText(ops, code, decoder);

      return result(text.trim() === "" ? "(no output)" : text);
    });

    yield* code.lm.registerTool<unknown>(EXECUTE_CODE_TOOL, {
      prepareInvocation(options) {
        const input = Schema.decodeUnknownSync(ExecuteCodeInput)(options.input);
        return {
          invocationMessage: "Running code in the marimo kernel…",
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
        return runPromise(
          executeCode(options.input).pipe(
            Effect.catchTags({
              // No live kernel — the notebook is open but nothing can run. Tell
              // the agent to have the user start one rather than file-edit.
              NoActiveKernelError: () =>
                Effect.succeed(
                  result(
                    `This marimo notebook is open but has no active kernel, so code can't run. ` +
                      `Ask the user to select a kernel and run a cell to start it, then try again. ` +
                      `Do not edit the \`.py\` file directly as a fallback — that bypasses the live kernel.`,
                  ),
                ),
              // Sandbox kernel needs a script file on disk to resolve its venv.
              UnsavedNotebookError: () =>
                Effect.succeed(
                  result(
                    `This notebook uses a sandbox kernel, which requires the notebook to be saved to a file before it can run. ` +
                      `Ask the user to save it, then try again.`,
                  ),
                ),
            }),
          ),
          { signal: signalFromToken(token) },
        );
      },
    });
  }),
);
