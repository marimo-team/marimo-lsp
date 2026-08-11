// @ts-expect-error
import { transitionCell as untypedTransitionCell } from "@marimo-team/frontend/unstable_internal/core/cells/cell.ts?nocheck";
import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import { Brand, Data, Option } from "effect";

import type { NotebookCellId } from "../schemas/MarimoNotebookDocument.ts";
import type { CellOperationNotification, CellRuntimeState } from "../types.ts";

export type CellRunId = Brand.Branded<string, "CellRunId">;
export const CellRunId = Brand.nominal<CellRunId>();

/**
 * Where a cell is in its current run.
 *
 * Derived by the reducer, never read off the wire, and resource-free — the live
 * execution lives in the interpreter, not here.
 */
export type RunPhase = Data.TaggedEnum<{
  Idle: {};
  Queued: { readonly runId: CellRunId };
  Running: { readonly runId: CellRunId };
  Completed: {};
}>;
export const RunPhase = Data.taggedEnum<RunPhase>();

/**
 * A `cell-op`, normalized for the reducer.
 *
 * {@link parseOp} folds the raw op into `CellRuntimeState` and pulls out the run
 * id and timings, so the reducer never sees marimo's nullable wire status. The
 * caller supplies an identity for one-off error presentations that have no
 * upstream run.
 */
export type Op = Data.TaggedEnum<{
  Queue: { readonly runId: CellRunId; readonly next: CellRuntimeState };
  Start: {
    readonly startTime: number;
    readonly next: CellRuntimeState;
    readonly ephemeralRunId: CellRunId;
  };
  Settle: {
    readonly success: boolean;
    readonly endTime: number | undefined;
    readonly next: CellRuntimeState;
    readonly ephemeralRunId: CellRunId;
  };
  Update: {
    readonly next: CellRuntimeState;
    readonly ephemeralRunId: CellRunId;
  };
  Interrupt: {};
}>;
export const Op = Data.taggedEnum<Op>();

/**
 * One side effect the reducer wants done, as data. The interpreter performs it.
 */
export type Action = Data.TaggedEnum<{
  CreateExecution: { readonly runId: CellRunId };
  StartExecution: {
    readonly runId: CellRunId;
    readonly startTime: number | undefined;
  };
  EmitOutputs: {
    readonly runId: CellRunId;
    readonly state: CellRuntimeState;
  };
  FinalizeOutputs: {
    readonly runId: CellRunId;
    readonly state: CellRuntimeState;
  };
  EndExecution: {
    readonly runId: CellRunId;
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
export interface CellRunState {
  readonly id: NotebookCellId;
  readonly state: CellRuntimeState;
  readonly phase: RunPhase;
}

export function makeCellRunState(id: NotebookCellId): CellRunState {
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
  ephemeralRunId: CellRunId,
): Option.Option<Op> {
  switch (msg.status) {
    case "queued": {
      const runId = Option.fromNullishOr(msg.run_id).pipe(
        Option.map(CellRunId),
      );
      return Option.map(runId, (id) => Op.Queue({ runId: id, next }));
    }
    case "running":
      return Option.some(
        Op.Start({
          startTime: (msg.timestamp ?? 0) * 1000,
          next,
          ephemeralRunId,
        }),
      );
    case "idle":
      return Option.some(
        Op.Settle({
          // A marimo-error output channel is the kernel's signal that the run
          // raised — report failure so VS Code shows the red error icon.
          success: next.output?.channel !== "marimo-error",
          endTime: msg.timestamp == null ? undefined : msg.timestamp * 1000,
          next,
          ephemeralRunId,
        }),
      );
    default:
      return Option.some(Op.Update({ next, ephemeralRunId }));
  }
}

const activeRunId = (phase: RunPhase): CellRunId | undefined =>
  phase._tag === "Queued" || phase._tag === "Running" ? phase.runId : undefined;

const isError = (state: CellRuntimeState): boolean =>
  state.output?.channel === "marimo-error";

/**
 * The cell run reducer: pure, total, vscode-free. Decides the next
 * {@link RunPhase} and the ordered {@link Action}s a single {@link Op} causes.
 * The one place that decides what a cell-op *means*.
 */
export function step(
  entry: CellRunState,
  op: Op,
): { readonly entry: CellRunState; readonly actions: ReadonlyArray<Action> } {
  return Op.$match(op, {
    Interrupt: () => {
      const runId = activeRunId(entry.phase);
      if (runId === undefined) return { entry, actions: [] };
      return {
        entry: { ...entry, phase: RunPhase.Completed() },
        actions: [
          Action.EndExecution({
            runId,
            success: false,
            endTime: undefined,
          }),
        ],
      };
    },

    Queue: ({ runId, next }) => {
      const actions: Action[] = [];
      if (next.staleInputs) actions.push(Action.InvalidateCell());
      // Record clears stale; clear any prior runtime-error squiggle.
      actions.push(Action.RecordExecution(), Action.ClearRuntimeError());
      // End any still-running prior execution before creating the new one.
      const previousRunId = activeRunId(entry.phase);
      if (previousRunId !== undefined) {
        actions.push(
          Action.EndExecution({
            runId: previousRunId,
            success: true,
            endTime: undefined,
          }),
        );
      }
      actions.push(Action.CreateExecution({ runId }));
      return {
        entry: { ...entry, state: next, phase: RunPhase.Queued({ runId }) },
        actions,
      };
    },

    Start: ({ ephemeralRunId, startTime, next }) => {
      const actions: Action[] = [];
      if (next.staleInputs) actions.push(Action.InvalidateCell());
      let phase = entry.phase;
      if (entry.phase._tag === "Queued") {
        actions.push(
          Action.StartExecution({ runId: entry.phase.runId, startTime }),
        );
        phase = RunPhase.Running({ runId: entry.phase.runId });
      }
      const runId = activeRunId(phase);
      if (runId !== undefined) {
        actions.push(Action.EmitOutputs({ runId, state: next }));
      } else if (isError(next)) {
        actions.push(
          ...ephemeralError(ephemeralRunId, next, {
            applyDiagnostic: false,
          }),
        );
      }
      return { entry: { ...entry, state: next, phase }, actions };
    },

    Update: ({ ephemeralRunId, next }) => {
      const actions: Action[] = [];
      if (next.staleInputs) actions.push(Action.InvalidateCell());
      const runId = activeRunId(entry.phase);
      if (runId !== undefined) {
        actions.push(Action.EmitOutputs({ runId, state: next }));
      } else if (isError(next)) {
        actions.push(
          ...ephemeralError(ephemeralRunId, next, {
            applyDiagnostic: false,
          }),
        );
      }
      return { entry: { ...entry, state: next, phase: entry.phase }, actions };
    },

    Settle: ({ success, endTime, ephemeralRunId, next }) => {
      const actions: Action[] = [];
      if (next.staleInputs) actions.push(Action.InvalidateCell());
      const runId = activeRunId(entry.phase);
      if (runId !== undefined) {
        actions.push(
          Action.FinalizeOutputs({ runId, state: next }),
          Action.ApplyRuntimeError({ state: next }),
          Action.EndExecution({ runId, success, endTime }),
        );
        return {
          entry: { ...entry, state: next, phase: RunPhase.Completed() },
          actions,
        };
      }
      // No live execution: show a one-off execution for an error, and always
      // reconcile the squiggle (clears it when there's no in-cell frame).
      if (isError(next)) {
        actions.push(
          ...ephemeralError(ephemeralRunId, next, { applyDiagnostic: true }),
        );
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
  runId: CellRunId,
  next: CellRuntimeState,
  opts: { readonly applyDiagnostic: boolean },
): Action[] {
  return [
    Action.CreateExecution({ runId }),
    Action.StartExecution({ runId, startTime: undefined }),
    Action.FinalizeOutputs({ runId, state: next }),
    ...(opts.applyDiagnostic
      ? [Action.ApplyRuntimeError({ state: next })]
      : []),
    Action.EndExecution({ runId, success: false, endTime: undefined }),
  ];
}
