import { Effect, Either, Layer, Option, Runtime, Stream } from "effect";

import { MarimoNotebookDocument } from "../schemas.ts";
import { scratchCellNotificationsToVsCodeOutput } from "../services/ExecutionRegistry.ts";
import { KernelManager } from "../services/KernelManager.ts";
import { NotebookEditorRegistry } from "../services/NotebookEditorRegistry.ts";
import { VsCode } from "../services/VsCode.ts";

const TOOL_NAME = "marimo_execute_python";

interface ExecutePythonInput {
  code: string;
}

/**
 * Registers a Language Model Tool that can execute Python code
 * in the active marimo notebook. Agents like Copilot can invoke this tool.
 */
export const ChatParticipantLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const kernel = yield* KernelManager;
    const editors = yield* NotebookEditorRegistry;
    const runPromise = Runtime.runPromise(yield* Effect.runtime());

    yield* code.lm.registerTool<ExecutePythonInput>(TOOL_NAME, {
      invoke: ({ input }, _token) =>
        runPromise(
          Effect.gen(function* () {
            yield* Effect.logDebug("Tool invoked").pipe(
              Effect.annotateLogs({ code: input.code.slice(0, 100) }),
            );

            const editorOpt = yield* editors.getActiveNotebookEditor();

            if (Option.isNone(editorOpt)) {
              yield* Effect.logWarning("No active notebook for tool execution");
              return new code.LanguageModelToolResult([
                new code.LanguageModelTextPart(
                  "Error: No active marimo notebook. Please open a notebook first.",
                ),
              ]);
            }

            const editor = editorOpt.value;
            const notebook = MarimoNotebookDocument.from(editor.notebook);

            const result = yield* kernel
              .executeCodeUnsafe(notebook.id, input.code)
              .pipe(
                Stream.filterMap((op) =>
                  scratchCellNotificationsToVsCodeOutput(op, code),
                ),
                Stream.runCollect,
                Effect.either,
              );

            if (Either.isLeft(result)) {
              yield* Effect.logError("Tool execution failed", result.left);
              return new code.LanguageModelToolResult([
                new code.LanguageModelTextPart(`Error: ${result.left.message}`),
              ]);
            }

            const itemsByChannel = Object.groupBy(
              Array.from(result.right),
              (item) =>
                typeof item.metadata?.channel === "string"
                  ? item.metadata.channel
                  : "output",
            );

            const decoder = new TextDecoder();
            const parts: string[] = [];

            for (const ch of ["stdout", "stderr", "output"]) {
              const outputs = itemsByChannel[ch];
              if (!outputs?.length) continue;

              const text = outputs
                .flatMap((o) => o.items)
                .map((item) => {
                  if (item.mime.startsWith("image/")) return "";
                  try {
                    return decoder.decode(item.data);
                  } catch {
                    return "";
                  }
                })
                .join("");

              if (text) {
                parts.push(`[${ch}]\n${text}`);
              }
            }

            const outputText = parts.join("\n\n") || "(no output)";

            yield* Effect.logDebug("Tool execution complete").pipe(
              Effect.annotateLogs({ outputLength: outputText.length }),
            );

            return new code.LanguageModelToolResult([
              new code.LanguageModelTextPart(outputText),
            ]);
          }),
        ),
    });

    yield* Effect.logInfo(`Language model tool registered: ${TOOL_NAME}`);
  }),
);
