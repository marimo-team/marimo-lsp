import { Effect, Layer } from "effect";

import { CellExecutions } from "../kernel/CellExecutions.ts";
import { NotebookRuntime } from "../kernel/NotebookRuntime.ts";
import { NotebookEditorRegistry } from "../notebook/NotebookEditorRegistry.ts";
import { NotebookVariables } from "../panel/variables/NotebookVariables.ts";

declare global {
  // oxlint-disable-next-line eslint/no-var
  var __marimoDebug: Record<string, unknown> | undefined;
}

/**
 * Debug layer that exposes extension internals on `globalThis` when
 * `MARIMO_DEBUG=1`. This enables runtime inspection via the Node inspector
 * (`--inspect-extensions`) without modifying other layers.
 *
 * Note: `__marimoVsCode` (the raw vscode module) is set in VsCode.ts,
 * which is the only file allowed to import "vscode" directly.
 */
export const DebugLayerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    if (process.env.MARIMO_DEBUG !== "1") return;

    globalThis.__marimoDebug = {
      cellExecutions: yield* CellExecutions,
      notebookVariables: yield* NotebookVariables,
      notebookEditorRegistry: yield* NotebookEditorRegistry,
      notebookRuntime: yield* NotebookRuntime,
    };
  }),
);
