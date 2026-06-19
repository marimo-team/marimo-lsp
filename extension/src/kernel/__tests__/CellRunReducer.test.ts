import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import { describe, expect, it } from "vitest";

import { cellId } from "../../lib/__tests__/branded.ts";
import type { CellRuntimeState } from "../../types.ts";
import {
  Action,
  type CellRunEntry,
  Op,
  RunId,
  RunPhase,
  step,
} from "../CellRunReducer.ts";

const ID = cellId("cell-1");
const RUN = RunId("run-1");

const entry = (phase: RunPhase): CellRunEntry => ({
  id: ID,
  state: createCellRuntimeState(),
  phase,
});

const okState = (): CellRuntimeState => createCellRuntimeState();
const errorState = (): CellRuntimeState => ({
  ...createCellRuntimeState(),
  output: {
    channel: "marimo-error",
    mimetype: "application/vnd.marimo+error",
    data: [],
    timestamp: 0,
  },
});
const staleState = (): CellRuntimeState => ({
  ...createCellRuntimeState(),
  staleInputs: true,
});

/** The sequence of action tags — the load-bearing, order-sensitive bit. */
const tags = (actions: ReadonlyArray<Action>) => actions.map((a) => a._tag);

describe("cell run reducer", () => {
  it("drives a normal run: queue → start → update → settle", () => {
    let e = entry(RunPhase.Idle());

    const queued = step(e, Op.Queue({ runId: RUN, next: okState() }));
    expect(tags(queued.actions)).toEqual([
      "RecordExecution",
      "ClearRuntimeError",
      "CreateExecution",
    ]);
    expect(queued.entry.phase).toEqual(RunPhase.Queued({ runId: RUN }));
    e = queued.entry;

    const started = step(e, Op.Start({ startTime: 5, next: okState() }));
    expect(tags(started.actions)).toEqual(["StartExecution", "EmitOutputs"]);
    expect(started.entry.phase).toEqual(RunPhase.Running({ runId: RUN }));
    e = started.entry;

    const updated = step(e, Op.Update({ next: okState() }));
    expect(tags(updated.actions)).toEqual(["EmitOutputs"]);
    e = updated.entry;

    const settled = step(
      e,
      Op.Settle({ success: true, endTime: 9, next: okState() }),
    );
    expect(tags(settled.actions)).toEqual([
      "FinalizeOutputs",
      "ApplyRuntimeError",
      "EndExecution",
    ]);
    expect(settled.entry.phase).toEqual(RunPhase.Completed());
  });

  it("settles a raised cell as a failure", () => {
    const running = entry(RunPhase.Running({ runId: RUN }));
    const { actions } = step(
      running,
      Op.Settle({ success: false, endTime: undefined, next: errorState() }),
    );
    const end = actions.find((a) => a._tag === "EndExecution");
    expect(end).toEqual(
      Action.EndExecution({ success: false, endTime: undefined }),
    );
  });

  it("ends the prior execution before re-queuing (race guard)", () => {
    const running = entry(RunPhase.Running({ runId: RUN }));
    const { actions } = step(
      running,
      Op.Queue({ runId: RunId("run-2"), next: okState() }),
    );
    expect(tags(actions)).toEqual([
      "RecordExecution",
      "ClearRuntimeError",
      "EndExecution",
      "CreateExecution",
    ]);
    // The prior run is ended as a success — it's superseded, not failed.
    const end = actions.find((a) => a._tag === "EndExecution");
    expect(end).toEqual(
      Action.EndExecution({ success: true, endTime: undefined }),
    );
  });

  it("interrupts a live run, and is a no-op otherwise", () => {
    const running = step(
      entry(RunPhase.Running({ runId: RUN })),
      Op.Interrupt(),
    );
    expect(tags(running.actions)).toEqual(["EndExecution"]);
    expect(running.entry.phase).toEqual(RunPhase.Completed());

    const idle = step(entry(RunPhase.Idle()), Op.Interrupt());
    expect(idle.actions).toEqual([]);
    expect(idle.entry.phase).toEqual(RunPhase.Idle());
  });

  it("renders a compile error with no prior run via an ephemeral execution", () => {
    const { actions, entry: next } = step(
      entry(RunPhase.Idle()),
      Op.Settle({ success: false, endTime: undefined, next: errorState() }),
    );
    expect(tags(actions)).toEqual([
      "CreateExecution",
      "StartExecution",
      "FinalizeOutputs",
      "ApplyRuntimeError",
      "EndExecution",
    ]);
    // The cell never entered a tracked run, so it stays Idle.
    expect(next.phase).toEqual(RunPhase.Idle());
  });

  it("reconciles the squiggle on an idle with nothing to render", () => {
    const { actions } = step(
      entry(RunPhase.Idle()),
      Op.Settle({ success: true, endTime: undefined, next: okState() }),
    );
    expect(tags(actions)).toEqual(["ApplyRuntimeError"]);
  });

  it("invalidates the cell when an op carries stale inputs", () => {
    const { actions } = step(
      entry(RunPhase.Running({ runId: RUN })),
      Op.Update({ next: staleState() }),
    );
    expect(actions[0]).toEqual(Action.InvalidateCell());
  });
});
