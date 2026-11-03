import * as Vitest from "@effect/vitest";
import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import { Effect, Layer, Option } from "effect";
import type * as vscode from "vscode";

import * as CellOutputProjections from "../../src/kernel/CellOutputProjections.ts";
import { CellCommand, runIdFromWire } from "../../src/kernel/CellRunReducer.ts";
import { DocumentExecutionSession } from "../../src/kernel/DocumentExecutionSession.ts";
import * as VsCodeCellDrive from "../../src/kernel/VsCodeCellDrive.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../../src/schemas/MarimoNotebookDocument.ts";
import type { CellRuntimeState } from "../../src/types.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as EffectTest from "../lib/EffectTest.ts";

const projectionsLayer = CellOutputProjections.layer.pipe(
  Layer.provide(VsCodeTest.layer),
);
const cellDriveLayer = VsCodeCellDrive.layer.pipe(
  Layer.provide(VsCodeTest.layer),
  Layer.provide(projectionsLayer),
);
const it = EffectTest.make(
  Layer.mergeAll(VsCodeTest.layer, projectionsLayer, cellDriveLayer),
);

const errorState = (): CellRuntimeState => ({
  ...createCellRuntimeState(),
  output: {
    channel: "marimo-error",
    mimetype: "application/vnd.marimo+error",
    data: [{ type: "syntax", msg: "invalid syntax" }],
    timestamp: 0,
  },
});

Vitest.describe("VsCodeCellDrive", () => {
  it.effect(
    "does not update outputs before the execution starts",
    Effect.fn(function* () {
      const editor = VsCodeTest.makeNotebookEditor("/test/notebook.py", {
        data: {
          cells: [
            {
              kind: 1,
              value: "x = 1",
              languageId: "python",
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "cell-1" },
              }),
            },
          ],
        },
      });
      const notebook = MarimoNotebookDocument.from(editor.notebook);
      const cellId = Option.getOrThrow(notebook.cellAt(0).id);
      const runId = Option.getOrThrow(runIdFromWire("run-1"));
      const events: string[] = [];
      const outputs: vscode.NotebookCellOutput[] = [
        ...editor.notebook.cellAt(0).outputs,
      ];
      const execution: vscode.NotebookCellExecution = {
        cell: Object.create(editor.notebook.cellAt(0), {
          outputs: { get: () => outputs },
        }),
        executionOrder: undefined,
        token: {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose() {} }),
        },
        start: () => events.push("start"),
        end: () => {},
        clearOutput: async () => {
          events.push("clear");
          outputs.length = 0;
        },
        appendOutput: async (out) => {
          events.push("append");
          outputs.push(...(Array.isArray(out) ? out : [out]));
        },
        replaceOutput: async () => {},
        appendOutputItems: async () => {},
        replaceOutputItems: async () => {},
      };
      const drive = (yield* VsCodeCellDrive.Service).bind({
        notebook,
        controller: { createNotebookCellExecution: () => execution },
      });
      const cell = { notebookId: notebook.id, cellId };

      yield* drive(cell, CellCommand.OpenRun({ runId }));
      yield* drive(
        cell,
        CellCommand.RenderOutputs({
          runId,
          state: errorState(),
          final: false,
        }),
      );
      Vitest.expect(events).toEqual([]);

      yield* drive(cell, CellCommand.StartRun({ runId, at: Option.none() }));
      yield* drive(
        cell,
        CellCommand.RenderOutputs({
          runId,
          state: errorState(),
          final: false,
        }),
      );
      Vitest.expect(events).toEqual(["start", "append"]);
    }),
  );

  it.effect.each([
    "untracked error",
    "graph diagnostic",
    "cleared graph diagnostic",
    "cleared graph diagnostic before a new run",
  ] as const)(
    "presents %s",
    Effect.fn(function* (scenario) {
      const editor = VsCodeTest.makeNotebookEditor("/test/notebook.py", {
        data: {
          cells: [
            {
              kind: 1,
              value: "x =",
              languageId: "python",
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "cell-1" },
              }),
            },
          ],
        },
      });
      const notebook = MarimoNotebookDocument.from(editor.notebook);
      const cellId = Option.getOrThrow(notebook.cellAt(0).id);
      const events: string[] = [];
      const startsRun =
        scenario === "cleared graph diagnostic before a new run";
      const clearsDiagnostic =
        scenario === "cleared graph diagnostic" || startsRun;
      const firstAppend = Promise.withResolvers<void>();
      const firstEnd = Promise.withResolvers<void>();
      const releaseAppend = Promise.withResolvers<void>();
      let outputsWhenRunStarted:
        | readonly vscode.NotebookCellOutput[]
        | undefined;
      const outputs: vscode.NotebookCellOutput[] = [
        ...editor.notebook.cellAt(0).outputs,
      ];
      const execution: vscode.NotebookCellExecution = {
        cell: Object.create(editor.notebook.cellAt(0), {
          outputs: { get: () => outputs },
        }),
        executionOrder: undefined,
        token: {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose() {} }),
        },
        start: (at) => {
          events.push("start");
          if (at !== undefined) outputsWhenRunStarted = [...outputs];
        },
        end: (success) => {
          events.push(`end:${success}`);
          firstEnd.resolve();
        },
        clearOutput: async () => {
          events.push("clear");
          outputs.length = 0;
        },
        appendOutput: async (out) => {
          events.push("append");
          outputs.push(...(Array.isArray(out) ? out : [out]));
          firstAppend.resolve();
          if (startsRun) await releaseAppend.promise;
        },
        replaceOutput: async () => {},
        appendOutputItems: async () => {},
        replaceOutputItems: async (items, out) => {
          events.push("finalize");
          const index = outputs.indexOf(out);
          outputs[index] = {
            items: Array.isArray(items) ? [...items] : [items],
            metadata: out.metadata,
          };
        },
      };
      const cellDrive = yield* VsCodeCellDrive.Service;

      const drive = cellDrive.bind({
        notebook,
        controller: { createNotebookCellExecution: () => execution },
      });
      if (scenario === "untracked error") {
        yield* drive(
          { notebookId: notebook.id, cellId },
          CellCommand.PresentUntrackedError({
            state: errorState(),
            applyDiagnostic: true,
          }),
        );
        Vitest.expect(events).toEqual([
          "start",
          "append",
          "finalize",
          "end:false",
        ]);
        return;
      }

      const session = yield* DocumentExecutionSession.make({
        notebook,
        getDrive: Effect.succeed(Option.some(drive)),
        onStaleChange: () => Effect.void,
      });
      // marimo 0.25.2 sends graph errors with a command-cycle ID, but never
      // queues the affected cell. This must reach the host output adapter.
      yield* Effect.gen(function* () {
        yield* session.apply({
          op: "cell-op",
          cell_id: cellId,
          status: null,
          run_id: "graph-command",
          console: [],
          output: {
            channel: "marimo-error",
            mimetype: "application/vnd.marimo+error",
            data: [{ type: "multiple-defs", name: "x", cells: ["other-cell"] }],
            timestamp: 0,
          },
        });
        // Observe the first diagnostic before admitting further notifications.
        // Hold its append in flight when testing conflation so the clear and
        // new run are guaranteed to share the next presentation batch.
        yield* Effect.promise(() =>
          startsRun ? firstAppend.promise : firstEnd.promise,
        );
        Vitest.expect(outputs).not.toHaveLength(0);
        // State-only notifications must not re-present the retained diagnostic
        // as an uncorrelated execution result.
        yield* session.apply({
          op: "cell-op",
          cell_id: cellId,
          run_id: "another-command",
          stale_inputs: true,
        });
        // An untagged state update must also avoid re-presenting the error;
        // unlike a mismatched run ID, correlation cannot suppress it.
        yield* session.apply({
          op: "cell-op",
          cell_id: cellId,
          stale_inputs: true,
        });
        if (clearsDiagnostic) {
          yield* session.apply({
            op: "cell-op",
            cell_id: cellId,
            run_id: "resolve-command",
            status: null,
            output: {
              channel: "output",
              mimetype: "text/plain",
              data: "",
              timestamp: 1,
            },
          });
        }
        if (startsRun) {
          yield* session.apply({
            op: "cell-op",
            cell_id: cellId,
            run_id: "corrected-run",
            status: "queued",
            timestamp: 2,
          });
          yield* session.apply({
            op: "cell-op",
            cell_id: cellId,
            run_id: "corrected-run",
            status: "running",
            timestamp: 3,
          });
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => releaseAppend.resolve()).pipe(
            Effect.andThen(session.close),
            Effect.andThen(session.drained),
          ),
        ),
      );

      const endings = events.filter((event) => event.startsWith("end:"));
      Vitest.expect(endings).toEqual([
        "end:undefined",
        ...(clearsDiagnostic ? ["end:undefined"] : []),
        ...(startsRun ? ["end:false"] : []),
      ]);
      if (startsRun) {
        Vitest.expect(outputsWhenRunStarted).toEqual([]);
      }
      if (clearsDiagnostic) {
        Vitest.expect(outputs).toEqual([]);
      } else {
        const text = outputs
          .flatMap((output) => output.items)
          .map((item) => new TextDecoder().decode(item.data))
          .join("\n");
        Vitest.expect(text).toContain("x");
        Vitest.expect(text).toContain("other-cell");
        Vitest.expect(outputs[0]?.metadata?.channel).toBe("marimo-error");
      }
    }),
  );
});
