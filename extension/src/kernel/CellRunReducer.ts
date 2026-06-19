// @ts-expect-error
import { transitionCell as untypedTransitionCell } from "@marimo-team/frontend/unstable_internal/core/cells/cell.ts?nocheck";
import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import { Brand, Data, Option } from "effect";

import type { NotebookCellId } from "../schemas/MarimoNotebookDocument.ts";
import type { CellOperationNotification, CellRuntimeState } from "../types.ts";

export type RunId = Brand.Branded<string, "RunId">;
export const RunId = Brand.nominal<RunId>();

/**
 * Where a cell is in its current run.
 *
 * Derived by the reducer, never read off the wire, and resource-free — the live
 * execution lives in the interpreter, not here.
 */
export type RunPhase = Data.TaggedEnum<{
  Idle: {};
  Queued: { readonly runId: RunId };
  Running: { readonly runId: RunId };
  Completed: {};
}>;
export const RunPhase = Data.taggedEnum<RunPhase>();

/**
 * A `cell-op`, normalized for the reducer.
 *
 * {@link parseOp} folds the raw op into `CellRuntimeState` and pulls out the run
 * id and timings, so the reducer never sees marimo's nullable wire status.
 */
export type Op = Data.TaggedEnum<{
  Queue: { readonly runId: RunId; readonly next: CellRuntimeState };
  Start: { readonly startTime: number; readonly next: CellRuntimeState };
  Settle: {
    readonly success: boolean;
    readonly endTime: number | undefined;
    readonly next: CellRuntimeState;
  };
  Update: { readonly next: CellRuntimeState };
  Interrupt: {};
}>;
export const Op = Data.taggedEnum<Op>();

/**
 * One side effect the reducer wants done, as data. The interpreter performs it.
 */
export type Action = Data.TaggedEnum<{
  CreateExecution: {};
  StartExecution: { readonly startTime: number | undefined };
  EmitOutputs: { readonly state: CellRuntimeState };
  FinalizeOutputs: { readonly state: CellRuntimeState };
  EndExecution: {
    readonly success: boolean;
    readonly endTime: number | undefined;
  };
  ApplyRuntimeError: { readonly state: CellRuntimeState };
  ClearRuntimeError: {};
  RecordExecution: {};
  InvalidateCell: {};
}>;
export const Action = Data.taggedEnum<Action>();

/** Pure, vscode-free per-cell reducer state. */
export interface CellRunEntry {
  readonly id: NotebookCellId;
  readonly state: CellRuntimeState;
  readonly phase: RunPhase;
}

export function makeCellRunEntry(id: NotebookCellId): CellRunEntry {
  return { id, state: createCellRuntimeState(), phase: RunPhase.Idle() };
}

/** Type-safe wrapper around marimo's imported `transitionCell`. */
export function transitionCell(
  cell: CellRuntimeState,
  message: CellOperationNotification,
): CellRuntimeState {
  return untypedTransitionCell(cell, message);
}

/**
 * Categorize a `cell-op` into an {@link Op}.
 *
 * `next` is the folded state (`transitionCell(prev, msg)`); the caller folds it
 * so it can persist the state even for an op we drop. Returns `None` only for a
 * `queued` op with no `run_id`, which can't be tracked.
 */
export function parseOp(
  next: CellRuntimeState,
  msg: CellOperationNotification,
): Option.Option<Op> {
  switch (msg.status) {
    case "queued": {
      const runId = Option.fromNullable(msg.run_id).pipe(Option.map(RunId));
      return Option.map(runId, (id) => Op.Queue({ runId: id, next }));
    }
    case "running":
      return Option.some(
        Op.Start({ startTime: (msg.timestamp ?? 0) * 1000, next }),
      );
    case "idle":
      return Option.some(
        Op.Settle({
          // A marimo-error output channel is the kernel's signal that the run
          // raised — report failure so VS Code shows the red error icon.
          success: next.output?.channel !== "marimo-error",
          endTime: msg.timestamp == null ? undefined : msg.timestamp * 1000,
          next,
        }),
      );
    default:
      return Option.some(Op.Update({ next }));
  }
}

const hasExecution = (phase: RunPhase): boolean =>
  phase._tag === "Queued" || phase._tag === "Running";

const isError = (state: CellRuntimeState): boolean =>
  state.output?.channel === "marimo-error";

/**
 * The cell run reducer: pure, total, vscode-free. Decides the next
 * {@link RunPhase} and the ordered {@link Action}s a single {@link Op} causes.
 * The one place that decides what a cell-op *means*.
 */
export function step(
  entry: CellRunEntry,
  op: Op,
): { readonly entry: CellRunEntry; readonly actions: ReadonlyArray<Action> } {
  return Op.$match(op, {
    Interrupt: () => {
      if (!hasExecution(entry.phase)) return { entry, actions: [] };
      return {
        entry: { ...entry, phase: RunPhase.Completed() },
        actions: [Action.EndExecution({ success: false, endTime: undefined })],
      };
    },

    Queue: ({ runId, next }) => {
      const actions: Action[] = [];
      if (next.staleInputs) actions.push(Action.InvalidateCell());
      // Record clears stale; clear any prior runtime-error squiggle.
      actions.push(Action.RecordExecution(), Action.ClearRuntimeError());
      // End any still-running prior execution before creating the new one.
      if (hasExecution(entry.phase)) {
        actions.push(
          Action.EndExecution({ success: true, endTime: undefined }),
        );
      }
      actions.push(Action.CreateExecution());
      return {
        entry: { ...entry, state: next, phase: RunPhase.Queued({ runId }) },
        actions,
      };
    },

    Start: ({ startTime, next }) => {
      const actions: Action[] = [];
      if (next.staleInputs) actions.push(Action.InvalidateCell());
      let phase = entry.phase;
      if (entry.phase._tag === "Queued") {
        actions.push(Action.StartExecution({ startTime }));
        phase = RunPhase.Running({ runId: entry.phase.runId });
      }
      if (hasExecution(phase)) {
        actions.push(Action.EmitOutputs({ state: next }));
      } else if (isError(next)) {
        actions.push(...ephemeralError(next, { applyDiagnostic: false }));
      }
      return { entry: { ...entry, state: next, phase }, actions };
    },

    Update: ({ next }) => {
      const actions: Action[] = [];
      if (next.staleInputs) actions.push(Action.InvalidateCell());
      if (hasExecution(entry.phase)) {
        actions.push(Action.EmitOutputs({ state: next }));
      } else if (isError(next)) {
        actions.push(...ephemeralError(next, { applyDiagnostic: false }));
      }
      return { entry: { ...entry, state: next, phase: entry.phase }, actions };
    },

    Settle: ({ success, endTime, next }) => {
      const actions: Action[] = [];
      if (next.staleInputs) actions.push(Action.InvalidateCell());
      if (hasExecution(entry.phase)) {
        actions.push(
          Action.FinalizeOutputs({ state: next }),
          Action.ApplyRuntimeError({ state: next }),
          Action.EndExecution({ success, endTime }),
        );
        return {
          entry: { ...entry, state: next, phase: RunPhase.Completed() },
          actions,
        };
      }
      // No live execution: show a one-off execution for an error, and always
      // reconcile the squiggle (clears it when there's no in-cell frame).
      if (isError(next)) {
        actions.push(...ephemeralError(next, { applyDiagnostic: true }));
      } else {
        actions.push(Action.ApplyRuntimeError({ state: next }));
      }
      return { entry: { ...entry, state: next, phase: entry.phase }, actions };
    },
  });
}

/**
 * Actions to render an error from a cell that never queued (e.g. a compile
 * error), which has no live execution: spin up a one-off execution, emit the
 * error, end it. `applyDiagnostic` also reconciles the squiggle, which only the
 * terminal `idle` op does.
 */
function ephemeralError(
  next: CellRuntimeState,
  opts: { readonly applyDiagnostic: boolean },
): Action[] {
  return [
    Action.CreateExecution(),
    Action.StartExecution({ startTime: undefined }),
    Action.FinalizeOutputs({ state: next }),
    ...(opts.applyDiagnostic
      ? [Action.ApplyRuntimeError({ state: next })]
      : []),
    Action.EndExecution({ success: false, endTime: undefined }),
  ];
}
