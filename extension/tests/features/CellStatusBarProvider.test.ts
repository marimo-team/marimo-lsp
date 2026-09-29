import * as Vitest from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import type * as vscode from "vscode";

import { commandId } from "../../src/commands.ts";
import enableCell from "../../src/commands/enableCell.ts";
import runStale from "../../src/commands/runStale.ts";
import * as CellStatusBarProvider from "../../src/features/CellStatusBarProvider.ts";
import * as CellExecutions from "../../src/kernel/CellExecutions.ts";
import * as NotebookDocumentSessions from "../../src/notebook/NotebookDocumentSessions.ts";
import { MarimoNotebookCell } from "../../src/schemas/MarimoNotebookDocument.ts";
import type * as Api from "../../src/schemas/Models.gen.ts";
import * as NotebookRuntimeTest from "../fake/NotebookRuntime.ts";
import * as TelemetryTest from "../fake/Telemetry.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as EffectTest from "../lib/EffectTest.ts";
import * as DocumentLifecycle from "../notebook/documentLifecycle.ts";

const it = EffectTest.make(
  CellStatusBarProvider.layer.pipe(
    Layer.provideMerge(CellExecutions.defaultLayer),
    Layer.provideMerge(NotebookDocumentSessions.layer),
    Layer.provideMerge(VsCodeTest.layer),
    Layer.provide(TelemetryTest.layer),
    Layer.provide(NotebookRuntimeTest.layerWith()),
  ),
);

const notebookUri = VsCodeTest.createNotebookUri("file:///test/notebook_mo.py");

function makeCell(
  metadata: typeof Api.CellMetadata.Encoded = {},
): vscode.NotebookCell {
  return VsCodeTest.createNotebookCell(
    VsCodeTest.createTestNotebookDocument(notebookUri),
    {
      kind: 1,
      value: "",
      languageId: "python",
      metadata: MarimoNotebookCell.createMetadata(metadata),
    },
    0,
  );
}

/** Status bar items every registered provider contributes for the cell. */
const items = Effect.fn("items")(function* (cell: vscode.NotebookCell) {
  const vscode = yield* VsCodeTest.Service;
  const providers = yield* vscode.statusBarProviders;
  const provided = yield* Effect.forEach(
    providers,
    (provider) => provider.provideCellStatusBarItems(cell),
    { concurrency: "unbounded" },
  );
  return provided.flat();
});

const openExecutions = Effect.fn("openExecutions")(function* (
  cell: vscode.NotebookCell,
) {
  const executions = yield* CellExecutions.Service;
  const sessions = yield* NotebookDocumentSessions.Service;
  yield* DocumentLifecycle.transition(cell.notebook, "opened");
  const session = sessions.forDocument(cell.notebook);
  if (Option.isNone(session)) {
    return yield* Effect.die("Expected an open notebook document session");
  }
  return yield* executions
    .open(session.value, { getDrive: Effect.succeed(Option.none()) })
    .pipe(Effect.orDie);
});

const markExecuted = Effect.fn("markExecuted")(function* (
  cell: vscode.NotebookCell,
) {
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
}, Effect.orDie);

const markStale = Effect.fn("markStale")(function* (cell: vscode.NotebookCell) {
  const notebook = yield* openExecutions(cell);
  const cellId = Option.getOrThrow(MarimoNotebookCell.from(cell).id);
  yield* notebook.apply({
    op: "cell-op",
    cell_id: cellId,
    status: "idle",
    stale_inputs: true,
  });
}, Effect.orDie);

const contains = (
  items: ReadonlyArray<{ readonly text: string }>,
  text: string,
) => items.some((item) => item.text.includes(text));

Vitest.describe("CellStatusBarProvider", () => {
  it.effect(
    "registers staleness, name, and disabled providers",
    Effect.fn(function* () {
      const vscode = yield* VsCodeTest.Service;
      Vitest.expect(yield* vscode.statusBarProviders).toHaveLength(3);
    }),
  );

  it.effect(
    "does not show staleness before a cell has executed",
    Effect.fn(function* () {
      const cell = makeCell({
        marimo: { name: "test_cell" },
        marimoRuntime: { stableId: "cell-1" },
      });

      Vitest.expect(contains(yield* items(cell), "Stale")).toBe(false);
    }),
  );

  it.effect(
    "does not show staleness after execution",
    Effect.fn(function* () {
      const cell = makeCell({
        marimo: { name: "test_cell" },
        marimoRuntime: { stableId: "cell-1" },
      });

      yield* markExecuted(cell);

      Vitest.expect(contains(yield* items(cell), "Stale")).toBe(false);
    }),
  );

  it.effect(
    "shows staleness after invalidation",
    Effect.fn(function* () {
      const cell = makeCell({
        marimo: { name: "test_cell" },
        marimoRuntime: { stableId: "cell-1" },
      });
      yield* markStale(cell);

      const stale = (yield* items(cell)).find((item) =>
        item.text.includes("Stale"),
      );

      Vitest.expect(stale?.text).toContain("Stale");
      Vitest.expect(stale?.tooltip).toContain("edited but not re-executed");
      Vitest.expect(stale?.command).toEqual({
        command: commandId(runStale.command),
        title: "Run stale cells",
        arguments: [cell],
      });
    }),
  );

  it.effect(
    "does not show the default cell name",
    Effect.fn(function* () {
      const cell = makeCell({ marimo: { name: "_" } });

      Vitest.expect(yield* items(cell)).toEqual([]);
    }),
  );

  it.effect(
    "shows a custom cell name",
    Effect.fn(function* () {
      const cell = makeCell({ marimo: { name: "my_custom_cell" } });

      const item = (yield* items(cell)).find((item) =>
        item.text.includes("my_custom_cell"),
      );
      Vitest.expect(item?.text).toContain("my_custom_cell");
      Vitest.expect(item?.tooltip).toContain("Cell name: my_custom_cell");
    }),
  );

  it.effect(
    "shows the setup cell with a gear icon",
    Effect.fn(function* () {
      const cell = makeCell({ marimo: { name: "setup" } });

      const item = (yield* items(cell)).find((item) =>
        item.text.includes("setup"),
      );
      Vitest.expect(item?.text).toContain("$(gear)");
      Vitest.expect(item?.tooltip).toContain("Setup cell");
    }),
  );

  it.effect(
    "shows no items for a cell without metadata",
    Effect.fn(function* () {
      Vitest.expect(yield* items(makeCell())).toEqual([]);
    }),
  );

  it.effect(
    "shows staleness and name simultaneously",
    Effect.fn(function* () {
      const cell = makeCell({
        marimo: { name: "my_cell" },
        marimoRuntime: { stableId: "cell-2" },
      });
      yield* markStale(cell);

      const provided = yield* items(cell);
      Vitest.expect(contains(provided, "Stale")).toBe(true);
      Vitest.expect(contains(provided, "my_cell")).toBe(true);
    }),
  );

  it.effect(
    "shows an enable action only for disabled cells",
    Effect.fn(function* () {
      const enabled = makeCell({
        marimo: { options: { disabled: false } },
        marimoRuntime: { stableId: "enabled" },
      });
      const disabled = makeCell({
        marimo: { options: { disabled: true } },
        marimoRuntime: { stableId: "disabled" },
      });

      const enabledItems = yield* items(enabled);
      Vitest.expect(
        enabledItems.some(
          (item) =>
            typeof item.command !== "string" &&
            item.command?.command === commandId(enableCell.command),
        ),
      ).toBe(false);

      const item = (yield* items(disabled)).find(
        (item) =>
          typeof item.command !== "string" &&
          item.command?.command === commandId(enableCell.command),
      );
      Vitest.expect(item?.text).toBe("$(circle-slash) Disabled");
      Vitest.expect(item?.tooltip).toBe("Cell is disabled; click to enable");
      Vitest.expect(item?.command).toEqual({
        command: commandId(enableCell.command),
        title: "Enable cell",
        arguments: [disabled],
      });
    }),
  );
});
