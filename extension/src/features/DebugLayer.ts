import { Effect, Layer } from "effect";

import { ControllerRegistry } from "../kernel/ControllerRegistry.ts";
import { ExecutionRegistry } from "../kernel/ExecutionRegistry.ts";
import { KernelManager } from "../kernel/KernelManager.ts";
import { SessionStateManager } from "../kernel/SessionStateManager.ts";
import { CellStateManager } from "../notebook/CellStateManager.ts";
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
      controllerRegistry: yield* ControllerRegistry,
      cellStateManager: yield* CellStateManager,
      executionRegistry: yield* ExecutionRegistry,
      variablesService: yield* VariablesService,
      notebookEditorRegistry: yield* NotebookEditorRegistry,
      kernelManager: yield* KernelManager,
      sessionStateManager: yield* SessionStateManager,
    };
  }),
);
