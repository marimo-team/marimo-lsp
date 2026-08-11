import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import { describe, expect, it } from "vite-plus/test";

import { cellId } from "../../lib/__tests__/branded.ts";
import type { CellRuntimeState } from "../../types.ts";
import {
  AcceptedSource,
  CellCommand,
  type CellRunState,
  Op,
  RunId,
  RunPhase,
  step,
} from "../CellRunReducer.ts";

const ID = cellId("cell-1");
const RUN = RunId("run-1");
const EPHEMERAL_RUN = RunId("ephemeral-run");

const entry = (phase: RunPhase): CellRunState => ({
  id: ID,
  state: createCellRuntimeState(),
  phase,
  acceptedSource: AcceptedSource.Unknown(),
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

/** The sequence of command tags — the load-bearing, order-sensitive bit. */
const tags = (commands: ReadonlyArray<CellCommand>) =>
  commands.map((command) => command._tag);

describe("cell run reducer", () => {
  it("drives a normal run: queue → start → update → settle", () => {
    let e = entry(RunPhase.Idle());

    const queued = step(e, Op.Queue({ runId: RUN, next: okState() }), "x = 1");
    expect(tags(queued.commands)).toEqual(["SetDiagnostic", "OpenRun"]);
    expect(queued.entry.phase).toEqual(RunPhase.Queued({ runId: RUN }));
    expect(queued.entry.acceptedSource).toEqual(
      AcceptedSource.Accepted({ source: "x = 1" }),
    );
    e = queued.entry;

    const started = step(
      e,
      Op.Start({
        startTime: 5,
        next: okState(),
        ephemeralRunId: EPHEMERAL_RUN,
      }),
    );
    expect(tags(started.commands)).toEqual(["StartRun", "RenderOutputs"]);
    expect(started.entry.phase).toEqual(RunPhase.Running({ runId: RUN }));
    e = started.entry;

    const updated = step(
      e,
      Op.Update({ next: okState(), ephemeralRunId: EPHEMERAL_RUN }),
    );
    expect(tags(updated.commands)).toEqual(["RenderOutputs"]);
    e = updated.entry;

    const settled = step(
      e,
      Op.Settle({
        success: true,
        endTime: 9,
        next: okState(),
        ephemeralRunId: EPHEMERAL_RUN,
      }),
    );
    expect(tags(settled.commands)).toEqual([
      "RenderOutputs",
      "SetDiagnostic",
      "CloseRun",
    ]);
    expect(settled.entry.phase).toEqual(RunPhase.Completed());
  });

  it("settles a raised cell as a failure", () => {
    const running = entry(RunPhase.Running({ runId: RUN }));
    const { commands } = step(
      running,
      Op.Settle({
        success: false,
        endTime: undefined,
        next: errorState(),
        ephemeralRunId: EPHEMERAL_RUN,
      }),
    );
    const end = commands.find((command) => command._tag === "CloseRun");
    expect(end).toEqual(
      CellCommand.CloseRun({ runId: RUN, success: false, at: undefined }),
    );
  });

  it("ends the prior execution before re-queuing (race guard)", () => {
    const running = entry(RunPhase.Running({ runId: RUN }));
    const { commands } = step(
      running,
      Op.Queue({ runId: RunId("run-2"), next: okState() }),
    );
    expect(tags(commands)).toEqual(["SetDiagnostic", "CloseRun", "OpenRun"]);
    // The prior run is ended as a success — it's superseded, not failed.
    const end = commands.find((command) => command._tag === "CloseRun");
    expect(end).toEqual(
      CellCommand.CloseRun({ runId: RUN, success: true, at: undefined }),
    );
  });

  it("interrupts a live run, and is a no-op otherwise", () => {
    const running = step(
      entry(RunPhase.Running({ runId: RUN })),
      Op.Interrupt(),
    );
    expect(tags(running.commands)).toEqual(["CloseRun"]);
    expect(running.entry.phase).toEqual(RunPhase.Completed());

    const idle = step(entry(RunPhase.Idle()), Op.Interrupt());
    expect(idle.commands).toEqual([]);
    expect(idle.entry.phase).toEqual(RunPhase.Idle());
  });

  it("renders a compile error with no prior run via an ephemeral execution", () => {
    const { commands, entry: next } = step(
      entry(RunPhase.Idle()),
      Op.Settle({
        success: false,
        endTime: undefined,
        next: errorState(),
        ephemeralRunId: EPHEMERAL_RUN,
      }),
    );
    expect(tags(commands)).toEqual([
      "OpenRun",
      "StartRun",
      "RenderOutputs",
      "SetDiagnostic",
      "CloseRun",
    ]);
    expect(
      commands.every(
        (command) =>
          command._tag === "SetDiagnostic" || command.runId === EPHEMERAL_RUN,
      ),
    ).toBe(true);
    // The cell never entered a tracked run, so it stays Idle.
    expect(next.phase).toEqual(RunPhase.Idle());
  });

  it("reconciles the squiggle on an idle with nothing to render", () => {
    const { commands } = step(
      entry(RunPhase.Idle()),
      Op.Settle({
        success: true,
        endTime: undefined,
        next: okState(),
        ephemeralRunId: EPHEMERAL_RUN,
      }),
    );
    expect(tags(commands)).toEqual(["SetDiagnostic"]);
  });

  it("invalidates the accepted source when an op carries stale inputs", () => {
    const { entry: next } = step(
      entry(RunPhase.Running({ runId: RUN })),
      Op.Update({ next: staleState(), ephemeralRunId: EPHEMERAL_RUN }),
    );
    expect(next.acceptedSource).toEqual(AcceptedSource.Invalidated());
  });

  it("records a queued source even when the operation carries stale inputs", () => {
    const { entry: next } = step(
      entry(RunPhase.Idle()),
      Op.Queue({ runId: RUN, next: staleState() }),
      "x = 1",
    );
    expect(next.acceptedSource).toEqual(
      AcceptedSource.Accepted({ source: "x = 1" }),
    );
  });
});
