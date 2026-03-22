import { Effect, Layer } from "effect";

import { CellStateManager } from "../services/CellStateManager.ts";
import { ControllerRegistry } from "../services/ControllerRegistry.ts";
import { ExecutionRegistry } from "../services/ExecutionRegistry.ts";
import { KernelManager } from "../services/KernelManager.ts";
import { NotebookEditorRegistry } from "../services/NotebookEditorRegistry.ts";
import { SessionStateManager } from "../services/SessionStateManager.ts";
import { VariablesService } from "../services/variables/VariablesService.ts";

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

    (globalThis as any).__marimoDebug = {
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
