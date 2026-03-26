import { Effect } from "effect";

/**
 * Provides Debug Adapter Protocol (DAP) bridge for marimo notebooks.
 *
 * TODO: re-implement
 */
export class DebugAdapter extends Effect.Service<DebugAdapter>()(
  "DebugAdapter",
  {
    scoped: Effect.succeed({}),
  },
) {}
