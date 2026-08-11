import { Effect, Layer } from "effect";

import { CellRuns } from "../kernel/CellRuns.ts";
import { NotebookRuntime } from "../kernel/NotebookRuntime.ts";
import { NotebookEditorRegistry } from "../notebook/NotebookEditorRegistry.ts";
import { VariablesService } from "../panel/variables/VariablesService.ts";

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
      cellRuns: yield* CellRuns,
      variablesService: yield* VariablesService,
      notebookEditorRegistry: yield* NotebookEditorRegistry,
      notebookRuntime: yield* NotebookRuntime,
    };
  }),
);
