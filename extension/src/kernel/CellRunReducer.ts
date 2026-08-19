// @ts-expect-error
import { transitionCell as untypedTransitionCell } from "@marimo-team/frontend/unstable_internal/core/cells/cell.ts?nocheck";
import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import { Brand, Data, Option } from "effect";

import type { NotebookCellId } from "../schemas/MarimoNotebookDocument.ts";
import type { CellOperationNotification, CellRuntimeState } from "../types.ts";

export type RunId = Brand.Branded<string, "RunId">;
const brandRunId = Brand.nominal<RunId>();

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

/** The source most recently accepted by the kernel. */
export type AcceptedSource = Data.TaggedEnum<{
  Unknown: {};
  Invalidated: {};
  Accepted: { readonly source: string };
}>;
export const AcceptedSource = Data.taggedEnum<AcceptedSource>();

/**
 * A `cell-op`, normalized for the reducer.
 *
 * {@link parseOp} folds the raw op into `CellRuntimeState` and pulls out the run
 * id and timings, so the reducer never sees marimo's nullable wire status.
 */
export type Op = Data.TaggedEnum<{
  Queue: { readonly runId: RunId; readonly next: CellRuntimeState };
  Start: {
    readonly startTime: number;
    readonly next: CellRuntimeState;
  };
  Settle: {
    readonly success: boolean;
    readonly endTime: Option.Option<number>;
    readonly next: CellRuntimeState;
  };
  Update: { readonly next: CellRuntimeState };
  Interrupt: {};
  Invalidate: {};
}>;
export const Op = Data.taggedEnum<Op>();

/** One host effect requested by the reducer. */
export type CellCommand = Data.TaggedEnum<{
  OpenRun: { readonly runId: RunId };
  StartRun: {
    readonly runId: RunId;
    readonly at: Option.Option<number>;
  };
  RenderOutputs: {
    readonly runId: RunId;
    readonly state: CellRuntimeState;
    readonly final: boolean;
  };
  CloseRun: {
    readonly runId: RunId;
    readonly success: boolean;
    readonly at: Option.Option<number>;
  };
  /** Present an error that arrived without a kernel-tracked run. */
  PresentUntrackedError: {
    readonly state: CellRuntimeState;
    readonly applyDiagnostic: boolean;
  };
  SetDiagnostic: { readonly state: Option.Option<CellRuntimeState> };
}>;
export const CellCommand = Data.taggedEnum<CellCommand>();

/** Pure, vscode-free per-cell reducer state. */
export interface CellRunState {
  readonly id: NotebookCellId;
  readonly state: CellRuntimeState;
  readonly phase: RunPhase;
  readonly acceptedSource: AcceptedSource;
}

export function makeCellRunState(id: NotebookCellId): CellRunState {
  return {
    id,
    state: createCellRuntimeState(),
    phase: RunPhase.Idle(),
    acceptedSource: AcceptedSource.Unknown(),
  };
}

/** Type-safe wrapper around marimo's imported `transitionCell`. */
export function transitionCell(
  cell: CellRuntimeState,
  message: CellOperationNotification,
): CellRuntimeState {
  return untypedTransitionCell(cell, message);
}

/**
 * Accept kernel-owned cell state without changing the host run lifecycle.
 *
 * Some state-only notifications are tagged with the run that caused them,
 * rather than a run of the target cell. Their presentation may not correlate,
 * but their state remains authoritative.
 */
export function acceptKernelState(
  entry: CellRunState,
  state: CellRuntimeState,
): CellRunState {
  return {
    ...entry,
    state,
    acceptedSource: state.staleInputs
      ? AcceptedSource.Invalidated()
      : entry.acceptedSource,
  };
}

/** The sole production boundary from a nullable wire string to a RunId. */
export const runIdFromWire = (
  runId: CellOperationNotification["run_id"],
): Option.Option<RunId> =>
  Option.fromNullishOr(runId).pipe(
    Option.filter((value) => value.length > 0),
    Option.map(brandRunId),
  );

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
      return runIdFromWire(msg.run_id).pipe(
        Option.map((runId) => Op.Queue({ runId, next })),
      );
    }
    case "running":
      return Option.some(
        Op.Start({
          startTime: (msg.timestamp ?? 0) * 1000,
          next,
        }),
      );
    case "idle":
      return Option.some(
        Op.Settle({
          // A marimo-error output channel is the kernel's signal that the run
          // raised — report failure so VS Code shows the red error icon.
          success: next.output?.channel !== "marimo-error",
          endTime: Option.fromNullishOr(msg.timestamp).pipe(
            Option.map((timestamp) => timestamp * 1000),
          ),
          next,
        }),
      );
    default:
      return Option.some(Op.Update({ next }));
  }
}

/** Returns the active RunId, if this phase owns one. */
export const activeRunId: (phase: RunPhase) => Option.Option<RunId> =
  RunPhase.$match({
    Idle: () => Option.none(),
    Queued: ({ runId }) => Option.some(runId),
    Running: ({ runId }) => Option.some(runId),
    Completed: () => Option.none(),
  });

const hasMarimoErrorOutput = (state: CellRuntimeState): boolean =>
  state.output?.channel === "marimo-error";

/**
 * The cell run reducer: pure, total, vscode-free. Decides the next
 * {@link RunPhase} and the ordered {@link CellCommand}s a single
 * {@link Op} causes.
 * The one place that decides what a cell-op *means*.
 */
export function step(
  entry: CellRunState,
  op: Op,
  source: Option.Option<string> = Option.none(),
): {
  readonly entry: CellRunState;
  readonly commands: ReadonlyArray<CellCommand>;
} {
  return Op.$match(op, {
    Invalidate: () => {
      const runId = activeRunId(entry.phase);
      const acceptedSource = AcceptedSource.$match(entry.acceptedSource, {
        Unknown: () => entry.acceptedSource,
        Invalidated: () => entry.acceptedSource,
        Accepted: () => AcceptedSource.Invalidated(),
      });
      if (Option.isNone(runId)) {
        return {
          entry: { ...entry, acceptedSource },
          commands: [],
        };
      }
      return {
        entry: {
          ...entry,
          phase: RunPhase.Completed(),
          acceptedSource,
        },
        commands: [
          CellCommand.CloseRun({
            runId: runId.value,
            success: false,
            at: Option.none(),
          }),
        ],
      };
    },

    Interrupt: () => {
      const runId = activeRunId(entry.phase);
      if (Option.isNone(runId)) {
        return { entry, commands: [] };
      }
      return {
        entry: { ...entry, phase: RunPhase.Completed() },
        commands: [
          CellCommand.CloseRun({
            runId: runId.value,
            success: false,
            at: Option.none(),
          }),
        ],
      };
    },

    Queue: ({ runId, next }) => {
      const commands: CellCommand[] = [];
      // Queue is the kernel's acknowledgement that it accepted this source.
      // It wins over `staleInputs` when both arrive on the same operation.
      const acceptedSource = Option.match(source, {
        onNone: () => entry.acceptedSource,
        onSome: (source) => AcceptedSource.Accepted({ source }),
      });
      commands.push(CellCommand.SetDiagnostic({ state: Option.none() }));
      // End any still-running prior execution before creating the new one.
      const previousRunId = activeRunId(entry.phase);
      if (Option.isSome(previousRunId)) {
        commands.push(
          CellCommand.CloseRun({
            runId: previousRunId.value,
            success: true,
            at: Option.none(),
          }),
        );
      }
      commands.push(CellCommand.OpenRun({ runId }));
      return {
        entry: {
          ...entry,
          state: next,
          phase: RunPhase.Queued({ runId }),
          acceptedSource,
        },
        commands,
      };
    },

    Start: ({ startTime, next }) => {
      const commands: CellCommand[] = [];
      let phase = entry.phase;
      if (RunPhase.$is("Queued")(entry.phase)) {
        commands.push(
          CellCommand.StartRun({
            runId: entry.phase.runId,
            at: Option.some(startTime),
          }),
        );
        phase = RunPhase.Running({ runId: entry.phase.runId });
      }
      const runId = activeRunId(phase);
      if (Option.isSome(runId)) {
        commands.push(
          CellCommand.RenderOutputs({
            runId: runId.value,
            state: next,
            final: false,
          }),
        );
      } else if (hasMarimoErrorOutput(next)) {
        commands.push(
          CellCommand.PresentUntrackedError({
            state: next,
            applyDiagnostic: false,
          }),
        );
      }
      return {
        entry: {
          ...acceptKernelState(entry, next),
          phase,
        },
        commands,
      };
    },

    Update: ({ next }) => {
      const commands: CellCommand[] = [];
      const runId = activeRunId(entry.phase);
      if (Option.isSome(runId)) {
        commands.push(
          CellCommand.RenderOutputs({
            runId: runId.value,
            state: next,
            final: false,
          }),
        );
      } else if (hasMarimoErrorOutput(next)) {
        commands.push(
          CellCommand.PresentUntrackedError({
            state: next,
            applyDiagnostic: false,
          }),
        );
      }
      return {
        entry: acceptKernelState(entry, next),
        commands,
      };
    },

    Settle: ({ success, endTime, next }) => {
      const commands: CellCommand[] = [];
      const accepted = acceptKernelState(entry, next);
      const runId = activeRunId(entry.phase);
      if (Option.isSome(runId)) {
        commands.push(
          CellCommand.RenderOutputs({
            runId: runId.value,
            state: next,
            final: true,
          }),
          CellCommand.SetDiagnostic({ state: Option.some(next) }),
          CellCommand.CloseRun({ runId: runId.value, success, at: endTime }),
        );
        return {
          entry: {
            ...accepted,
            phase: RunPhase.Completed(),
          },
          commands,
        };
      }
      // No live execution: show a one-off execution for an error, and always
      // reconcile the squiggle (clears it when there's no in-cell frame).
      if (hasMarimoErrorOutput(next)) {
        commands.push(
          CellCommand.PresentUntrackedError({
            state: next,
            applyDiagnostic: true,
          }),
        );
      } else {
        commands.push(CellCommand.SetDiagnostic({ state: Option.some(next) }));
      }
      return {
        entry: accepted,
        commands,
      };
    },
  });
}
