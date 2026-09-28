import { Context, Effect, Layer, Option } from "effect";
import type * as vscode from "vscode";

import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import * as CellExecutions from "../../kernel/CellExecutions.ts";
import * as DocumentLifecycle from "../../notebook/__tests__/documentLifecycle.ts";
import * as NotebookDocumentSessions from "../../notebook/NotebookDocumentSessions.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import type * as Api from "../../schemas/Models.gen.ts";
import * as CellStatusBarProvider from "../CellStatusBarProvider.ts";

const notebookUri = TestVsCode.createNotebookUri("file:///test/notebook_mo.py");

export function makeCell(
  metadata: typeof Api.CellMetadata.Encoded = {},
): vscode.NotebookCell {
  return TestVsCode.createNotebookCell(
    TestVsCode.createTestNotebookDocument(notebookUri),
    {
      kind: 1,
      value: "",
      languageId: "python",
      metadata: MarimoNotebookCell.createMetadata(metadata),
    },
    0,
  );
}

export interface Interface {
  readonly providerCount: Effect.Effect<number>;
  readonly items: (
    cell: vscode.NotebookCell,
  ) => Effect.Effect<ReadonlyArray<vscode.NotebookCellStatusBarItem>>;
  readonly markExecuted: (cell: vscode.NotebookCell) => Effect.Effect<void>;
  readonly markStale: (cell: vscode.NotebookCell) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/CellStatusBarProvider",
) {}

const environment = Layer.empty.pipe(
  Layer.provideMerge(CellStatusBarProvider.layer),
  Layer.provideMerge(CellExecutions.defaultLayer),
  Layer.provideMerge(NotebookDocumentSessions.layer),
  Layer.provideMerge(TestVsCode.layer),
  Layer.provide(TestTelemetryLive),
  Layer.provide(makeTestNotebookRuntime()),
);
const fixture = Layer.effect(
  Service,
  Effect.gen(function* () {
    const vscode = yield* TestVsCode.Service;
    const executions = yield* CellExecutions.Service;
    const sessions = yield* NotebookDocumentSessions.Service;

    const openExecutions = Effect.fn(function* (cell: vscode.NotebookCell) {
      yield* DocumentLifecycle.transition(cell.notebook, "opened").pipe(
        Effect.provideService(TestVsCode.Service, vscode),
        Effect.provideService(NotebookDocumentSessions.Service, sessions),
      );
      const session = sessions.forDocument(cell.notebook);
      if (Option.isNone(session)) {
        return yield* Effect.die("Expected an open notebook document session");
      }
      return yield* executions
        .open(session.value, {
          getDrive: Effect.succeed(Option.none()),
        })
        .pipe(Effect.orDie);
    });

    return Service.of({
      providerCount: Effect.map(
        vscode.statusBarProviders,
        (providers) => providers.length,
      ),
      items: (cell) =>
        Effect.flatMap(vscode.statusBarProviders, (providers) =>
          Effect.forEach(
            providers,
            (provider) => provider.provideCellStatusBarItems(cell),
            { concurrency: "unbounded" },
          ).pipe(Effect.map((items) => items.flat())),
        ),
      markExecuted: (cell) =>
        Effect.gen(function* () {
          const notebook = yield* openExecutions(cell);
          const cellId = Option.getOrThrow(MarimoNotebookCell.from(cell).id);
          yield* notebook.submit([{ cellId, source: "" }], Effect.void);
          yield* notebook.apply({
            op: "cell-op",
            cell_id: cellId,
            status: "queued",
            run_id: "run-1",
          });
          yield* notebook.apply({
            op: "cell-op",
            cell_id: cellId,
            status: "idle",
            run_id: "run-1",
          });
        }).pipe(Effect.orDie),
      markStale: (cell) =>
        Effect.gen(function* () {
          const notebook = yield* openExecutions(cell);
          const cellId = Option.getOrThrow(MarimoNotebookCell.from(cell).id);
          yield* notebook.apply({
            op: "cell-op",
            cell_id: cellId,
            status: "idle",
            stale_inputs: true,
          });
        }).pipe(Effect.orDie),
    });
  }),
).pipe(Layer.provide(environment));

export const layer = Layer.merge(environment, fixture);
