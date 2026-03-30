import { Schema } from "effect";

/**
 * Cell execution state
 */
export const CellState = Schema.Literal("idle", "queued", "running", "stale");
export type CellState = typeof CellState.Type;
