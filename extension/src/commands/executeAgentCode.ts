import { Effect, Schema, Stream } from "effect";

import { KernelManager } from "../kernel/KernelManager.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { NotebookIdFromString } from "../schemas/MarimoNotebookDocument.ts";

/**
 * Args for `marimo.executeAgentCode`. The notebook URI is a stringified
 * `vscode.Uri` (e.g. `file:///path/to/nb.py`); the code is a Python
 * snippet to execute in the notebook's kernel scratchpad — isolated
 * from the dependency graph, just like marimo Pair's `code_mode` flow.
 */
const Args = Schema.Struct({
  notebookUri: NotebookIdFromString,
  code: Schema.String,
});

/**
 * Result returned to the caller. `stdout`/`stderr` are the concatenated
 * console outputs streamed during execution; `error` is non-null when the
 * kernel reported a `marimo-error` channel output (typically a Python
 * exception traceback).
 */
export interface ExecuteAgentCodeResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string | null;
}

/**
 * Public command that wraps the extension's existing internal scratchpad
 * execute path (`KernelManager.executeCodeUnsafe`) so external tooling —
 * an MCP bridge, an HTTP sidecar, another VS Code extension — can drive
 * arbitrary code through the kernel that backs the open marimo notebook.
 *
 * This is the upstream-PR side of the agent-driven cell control flow
 * tracked by issues marimo-lsp#474 and marimo-lsp#488. The "scratchpad"
 * surface (vs. cell creation/edit) is chosen because once an agent can
 * execute code in the kernel, it can call marimo's own `_code_mode` API
 * from within that code to mutate cells, run them, and inspect state.
 */
export const executeAgentCode = Effect.fn("command.executeAgentCode")(
  function* (rawArgs: unknown) {
    const args = yield* Schema.decodeUnknown(Args)(rawArgs);
    const kernel = yield* KernelManager;

    const stream = kernel.executeCodeUnsafe(args.notebookUri, args.code);

    let stdout = "";
    let stderr = "";
    let error: string | null = null;

    yield* stream.pipe(
      Stream.runForEach((op) =>
        Effect.sync(() => {
          // `op` is a `CellOperationNotification` — its `output` /
          // `console` shape matches marimo's `OutputMessage` model.
          // We extract human-readable channels and ignore the rest;
          // structured outputs (rich displays) aren't useful to a
          // text-mode agent caller anyway.
          const opAny = op as unknown as {
            output?: {
              channel?: string;
              mimetype?: string;
              data?: unknown;
            } | null;
            console?: ReadonlyArray<{
              channel?: string;
              data?: unknown;
            }>;
          };

          // marimo's CellNotification.console is CellOutput[] | CellOutput |
          // null per the openapi schema (single = append one, list = append
          // all, [] = clear, null = unchanged). Normalize to an array.
          const rawConsole = opAny.console;
          const consoleItems: Array<{ channel?: string; data?: unknown }> =
            rawConsole == null
              ? []
              : Array.isArray(rawConsole)
                ? rawConsole
                : [rawConsole];

          for (const c of consoleItems) {
            const text = stringifyOutputData(c.data);
            if (!text) continue;
            if (c.channel === "stdout") stdout += text;
            else if (c.channel === "stderr") stderr += text;
          }

          const out = opAny.output;
          if (out && out.channel === "marimo-error") {
            const text = stringifyOutputData(out.data);
            if (text) error = error ? `${error}\n${text}` : text;
          }
        }),
      ),
    );

    return { stdout, stderr, error } satisfies ExecuteAgentCodeResult;
  },
  Effect.tapErrorCause(Effect.logError),
  Effect.catchAllCause((cause) =>
    Effect.gen(function* () {
      yield* showErrorAndPromptLogs(
        "marimo.executeAgentCode failed — see marimo output channel.",
      );
      // Re-fail so the caller's `executeCommand` rejects.
      return yield* Effect.failCause(cause);
    }),
  ),
);

function stringifyOutputData(data: unknown): string {
  if (data == null) return "";
  if (typeof data === "string") return data;
  return JSON.stringify(data);
}
