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
    readonly ephemeralRunId: RunId;
  };
  Settle: {
    readonly success: boolean;
    readonly endTime: number | undefined;
    readonly next: CellRuntimeState;
    readonly ephemeralRunId: RunId;
  };
  Update: { readonly next: CellRuntimeState; readonly ephemeralRunId: RunId };
  Interrupt: {};
}>;
export const Op = Data.taggedEnum<Op>();

/** One host effect requested by the reducer. */
export type CellCommand = Data.TaggedEnum<{
  OpenRun: { readonly runId: RunId };
  StartRun: { readonly runId: RunId; readonly at: number | undefined };
  RenderOutputs: {
    readonly runId: RunId;
    readonly state: CellRuntimeState;
    readonly final: boolean;
  };
  CloseRun: {
    readonly runId: RunId;
    readonly success: boolean;
    readonly at: number | undefined;
  };
  SetDiagnostic: { readonly state: Option.Option<CellRuntimeState> };
}>;
export const CellCommand = Data.taggedEnum<CellCommand>();

/** Pure, vscode-free per-cell reducer state. */
export interface CellRunEntry {
  readonly id: NotebookCellId;
  readonly state: CellRuntimeState;
  readonly phase: RunPhase;
  readonly acceptedSource: AcceptedSource;
}

export function makeCellRunEntry(id: NotebookCellId): CellRunEntry {
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
 * Categorize a `cell-op` into an {@link Op}.
 *
 * `next` is the folded state (`transitionCell(prev, msg)`); the caller folds it
 * so it can persist the state even for an op we drop. Returns `None` only for a
 * `queued` op with no `run_id`, which can't be tracked.
 */
export function parseOp(
  next: CellRuntimeState,
  msg: CellOperationNotification,
  ephemeralRunId: RunId,
): Option.Option<Op> {
  switch (msg.status) {
    case "queued": {
      const runId = Option.fromNullishOr(msg.run_id).pipe(Option.map(RunId));
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

const activeRunId = (phase: RunPhase): RunId | undefined =>
  phase._tag === "Queued" || phase._tag === "Running" ? phase.runId : undefined;

const isError = (state: CellRuntimeState): boolean =>
  state.output?.channel === "marimo-error";

/**
 * The cell run reducer: pure, total, vscode-free. Decides the next
 * {@link RunPhase} and the ordered {@link CellCommand}s a single
 * {@link Op} causes.
 * The one place that decides what a cell-op *means*.
 */
export function step(
  entry: CellRunEntry,
  op: Op,
  source?: string,
): {
  readonly entry: CellRunEntry;
  readonly commands: ReadonlyArray<CellCommand>;
} {
  return Op.$match(op, {
    Interrupt: () => {
      const runId = activeRunId(entry.phase);
      if (runId === undefined) return { entry, commands: [] };
      return {
        entry: { ...entry, phase: RunPhase.Completed() },
        commands: [
          CellCommand.CloseRun({ runId, success: false, at: undefined }),
        ],
      };
    },

    Queue: ({ runId, next }) => {
      const commands: CellCommand[] = [];
      // Queue is the kernel's acknowledgement that it accepted this source.
      // It wins over `staleInputs` when both arrive on the same operation.
      const acceptedSource =
        source === undefined
          ? entry.acceptedSource
          : AcceptedSource.Accepted({ source });
      commands.push(CellCommand.SetDiagnostic({ state: Option.none() }));
      // End any still-running prior execution before creating the new one.
      const previousRunId = activeRunId(entry.phase);
      if (previousRunId !== undefined) {
        commands.push(
          CellCommand.CloseRun({
            runId: previousRunId,
            success: true,
            at: undefined,
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

    Start: ({ startTime, next, ephemeralRunId }) => {
      const commands: CellCommand[] = [];
      let phase = entry.phase;
      if (entry.phase._tag === "Queued") {
        commands.push(
          CellCommand.StartRun({
            runId: entry.phase.runId,
            at: startTime,
          }),
        );
        phase = RunPhase.Running({ runId: entry.phase.runId });
      }
      const runId = activeRunId(phase);
      if (runId !== undefined) {
        commands.push(
          CellCommand.RenderOutputs({ runId, state: next, final: false }),
        );
      } else if (isError(next)) {
        commands.push(
          ...ephemeralError(ephemeralRunId, next, {
            applyDiagnostic: false,
          }),
        );
      }
      return {
        entry: {
          ...entry,
          state: next,
          phase,
          acceptedSource: next.staleInputs
            ? AcceptedSource.Invalidated()
            : entry.acceptedSource,
        },
        commands,
      };
    },

    Update: ({ next, ephemeralRunId }) => {
      const commands: CellCommand[] = [];
      const runId = activeRunId(entry.phase);
      if (runId !== undefined) {
        commands.push(
          CellCommand.RenderOutputs({ runId, state: next, final: false }),
        );
      } else if (isError(next)) {
        commands.push(
          ...ephemeralError(ephemeralRunId, next, {
            applyDiagnostic: false,
          }),
        );
      }
      return {
        entry: {
          ...entry,
          state: next,
          acceptedSource: next.staleInputs
            ? AcceptedSource.Invalidated()
            : entry.acceptedSource,
        },
        commands,
      };
    },

    Settle: ({ success, endTime, next, ephemeralRunId }) => {
      const commands: CellCommand[] = [];
      const acceptedSource = next.staleInputs
        ? AcceptedSource.Invalidated()
        : entry.acceptedSource;
      const runId = activeRunId(entry.phase);
      if (runId !== undefined) {
        commands.push(
          CellCommand.RenderOutputs({ runId, state: next, final: true }),
          CellCommand.SetDiagnostic({ state: Option.some(next) }),
          CellCommand.CloseRun({ runId, success, at: endTime }),
        );
        return {
          entry: {
            ...entry,
            state: next,
            phase: RunPhase.Completed(),
            acceptedSource,
          },
          commands,
        };
      }
      // No live execution: show a one-off execution for an error, and always
      // reconcile the squiggle (clears it when there's no in-cell frame).
      if (isError(next)) {
        commands.push(
          ...ephemeralError(ephemeralRunId, next, {
            applyDiagnostic: true,
          }),
        );
      } else {
        commands.push(CellCommand.SetDiagnostic({ state: Option.some(next) }));
      }
      return {
        entry: { ...entry, state: next, acceptedSource },
        commands,
      };
    },
  });
}

/**
 * Commands to render an error from a cell that never queued (e.g. a compile
 * error), which has no live execution: spin up a one-off execution, emit the
 * error, end it. `applyDiagnostic` also reconciles the squiggle, which only the
 * terminal `idle` op does.
 */
function ephemeralError(
  runId: RunId,
  next: CellRuntimeState,
  opts: { readonly applyDiagnostic: boolean },
): CellCommand[] {
  return [
    CellCommand.OpenRun({ runId }),
    CellCommand.StartRun({ runId, at: undefined }),
    CellCommand.RenderOutputs({ runId, state: next, final: true }),
    ...(opts.applyDiagnostic
      ? [CellCommand.SetDiagnostic({ state: Option.some(next) })]
      : []),
    CellCommand.CloseRun({ runId, success: false, at: undefined }),
  ];
}
