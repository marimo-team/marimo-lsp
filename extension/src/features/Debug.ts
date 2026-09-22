import { Effect, Layer } from "effect";

import * as CellExecutions from "../kernel/CellExecutions.ts";
import * as NotebookRuntime from "../kernel/NotebookRuntime.ts";
import * as NotebookEditorRegistry from "../notebook/NotebookEditorRegistry.ts";
import * as NotebookVariables from "../panel/variables/NotebookVariables.ts";

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
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (process.env.MARIMO_DEBUG !== "1") return;

    const debug = {
      cellExecutions: yield* CellExecutions.Service,
      notebookVariables: yield* NotebookVariables.Service,
      notebookEditorRegistry: yield* NotebookEditorRegistry.Service,
      notebookRuntime: yield* NotebookRuntime.Service,
    };

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        globalThis.__marimoDebug = debug;
      }),
      () =>
        Effect.sync(() => {
          if (globalThis.__marimoDebug === debug) {
            globalThis.__marimoDebug = undefined;
          }
        }),
    );
  }).pipe(Effect.withSpan("Debug.layer")),
);
