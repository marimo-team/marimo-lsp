import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Latch } from "effect";

import { cellId, notebookId } from "../../lib/__tests__/branded.ts";
import { CellExecutions, CellInput, type Drive } from "../CellExecutions.ts";

const acceptRun = (
  executions: CellExecutions["Service"],
  notebook: ReturnType<typeof notebookId>,
  cell: ReturnType<typeof cellId>,
  runId: string,
  drive: Drive,
) =>
  executions.accept(
    CellInput.Operation({
      notebookId: notebook,
      operation: {
        op: "cell-op",
        cell_id: cell,
        status: "queued",
        run_id: runId,
      },
      source: "x = 1",
      drive,
    }),
  );

describe("CellExecutions lifecycle", () => {
  it.effect("accepts the current source for a cascaded queued run", () =>
    Effect.gen(function* () {
      const executions = yield* CellExecutions;
      const notebook = notebookId("notebook");
      const cell = cellId("cell");
      const drive: Drive = () => Effect.void;

      yield* acceptRun(executions, notebook, cell, "run-1", drive);
      expect(
        yield* executions.isStale({
          notebookId: notebook,
          cellId: cell,
          source: "x = 2",
        }),
      ).toBe(true);

      yield* executions.accept(
        CellInput.Operation({
          notebookId: notebook,
          operation: {
            op: "cell-op",
            cell_id: cell,
            status: "queued",
            run_id: "run-2",
          },
          source: "x = 2",
          drive,
        }),
      );

      expect(
        yield* executions.isStale({
          notebookId: notebook,
          cellId: cell,
          source: "x = 2",
        }),
      ).toBe(false);
    }).pipe(Effect.provide(CellExecutions.layer)),
  );

  it.effect("removes a cell record and closes its active run", () =>
    Effect.gen(function* () {
      const executions = yield* CellExecutions;
      const notebook = notebookId("notebook");
      const cell = cellId("cell");
      const events: string[] = [];
      const drive: Drive = (_cell, command) =>
        Effect.sync(() => {
          if ("runId" in command) {
            events.push(`${command._tag}:${command.runId}`);
          }
        });

      yield* acceptRun(executions, notebook, cell, "run", drive);
      yield* executions.accept(
        CellInput.Operation({
          notebookId: notebook,
          operation: { op: "cell-op", cell_id: cell, stale_inputs: true },
          source: "x = 1",
          drive,
        }),
      );
      expect(
        yield* executions.isStale({
          notebookId: notebook,
          cellId: cell,
          source: "x = 1",
        }),
      ).toBe(true);

      yield* executions.accept(
        CellInput.CellsRemoved({ notebookId: notebook, cellIds: [cell] }),
      );

      expect(events).toContain("CloseRun:run");
      expect(
        yield* executions.isStale({
          notebookId: notebook,
          cellId: cell,
          source: "x = 1",
        }),
      ).toBe(false);
    }).pipe(Effect.provide(CellExecutions.layer)),
  );

  it.effect(
    "orders a reopened notebook after cleanup without blocking another notebook",
    () =>
      Effect.gen(function* () {
        const executions = yield* CellExecutions;
        const firstNotebook = notebookId("first-notebook");
        const secondNotebook = notebookId("second-notebook");
        const firstCell = cellId("first-cell");
        const secondCell = cellId("second-cell");
        const closeStarted = yield* Latch.make();
        const releaseClose = yield* Latch.make();
        const events: string[] = [];
        const drive =
          (name: string): Drive =>
          (_cell, command) =>
            Effect.gen(function* () {
              if ("runId" in command) {
                events.push(`${name}:${command._tag}:${command.runId}`);
              }
              if (command._tag === "CloseRun" && command.runId === "run-1") {
                yield* closeStarted.open;
                yield* releaseClose.await;
              }
            });

        yield* acceptRun(
          executions,
          firstNotebook,
          firstCell,
          "run-1",
          drive("first"),
        );
        const cleanup = yield* executions
          .accept(CellInput.Invalidated({ notebookId: firstNotebook }))
          .pipe(Effect.forkChild);
        yield* closeStarted.await;

        const reopen = yield* acceptRun(
          executions,
          firstNotebook,
          firstCell,
          "run-2",
          drive("reopened"),
        ).pipe(Effect.forkChild);
        yield* acceptRun(
          executions,
          secondNotebook,
          secondCell,
          "run-b",
          drive("second"),
        );

        expect(events).toContain("second:OpenRun:run-b");
        expect(events).not.toContain("reopened:OpenRun:run-2");

        yield* releaseClose.open;
        yield* Fiber.join(cleanup);
        yield* Fiber.join(reopen);
        expect(events).toContain("reopened:OpenRun:run-2");
      }).pipe(Effect.provide(CellExecutions.layer)),
  );
});
