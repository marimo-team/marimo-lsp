import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import {
  createNotebookCell,
  createNotebookUri,
  createTestNotebookDocument,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import { commandId } from "../../commands.ts";
import runStale from "../../commands/runStale.ts";
import { CellExecutions } from "../../kernel/CellExecutions.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import type * as Api from "../../schemas/Models.gen.ts";
import { CellStatusBarProviderLive } from "../CellStatusBarProvider.ts";

const withTestCtx = Effect.fn(function* () {
  const vscode = yield* TestVsCode.make();
  const layer = Layer.empty.pipe(
    Layer.provideMerge(CellStatusBarProviderLive),
    Layer.provideMerge(CellExecutions.Default),
    Layer.provideMerge(vscode.layer),
    Layer.provide(TestTelemetryLive),
    Layer.provide(makeTestNotebookRuntime()),
  );
  return { vscode, layer };
});

const notebookUri = createNotebookUri("file:///test/notebook_mo.py");

function createMockCell(
  uri: ReturnType<typeof createNotebookUri>,
  metadata: typeof Api.CellMetadata.Encoded = {},
) {
  return createNotebookCell(
    createTestNotebookDocument(uri),
    {
      kind: 1,
      value: "",
      languageId: "python",
      metadata: MarimoNotebookCell.createMetadata(metadata),
    },
    0,
  );
}

it.effect(
  "should register providers",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const providers = yield* ctx.vscode.getRegisteredStatusBarItemProviders();
      expect(providers.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "should show staleness for unexecuted cell",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();
    yield* Effect.gen(function* () {
      // Cell with stableId but never executed → not stale (no kernel yet)
      const cell = createMockCell(notebookUri, {
        marimo: { name: "test_cell" },
        marimoRuntime: { stableId: "cell-1" },
      });
      const providers = yield* ctx.vscode.getRegisteredStatusBarItemProviders();
      const items = yield* providers[0].provideCellStatusBarItems(cell);
      expect(items.some((item) => item.text.includes("Stale"))).toBe(false);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "should not show staleness after execution",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const executions = yield* CellExecutions;
      const cell = createMockCell(notebookUri, {
        marimo: { name: "test_cell" },
        marimoRuntime: { stableId: "cell-1" },
      });

      // Record execution — clears stale
      yield* executions.recordExecution(MarimoNotebookCell.from(cell));

      const providers = yield* ctx.vscode.getRegisteredStatusBarItemProviders();
      const items = yield* providers[0].provideCellStatusBarItems(cell);
      expect(items.some((item) => item.text.includes("Stale"))).toBe(false);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "should show staleness after invalidation",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const executions = yield* CellExecutions;
      const cell = createMockCell(notebookUri, {
        marimo: { name: "test_cell" },
        marimoRuntime: { stableId: "cell-1" },
      });

      // Execute then invalidate (simulates staleInputs from kernel)
      yield* executions.recordExecution(MarimoNotebookCell.from(cell));
      yield* executions.invalidateCell(MarimoNotebookCell.from(cell));

      const providers = yield* ctx.vscode.getRegisteredStatusBarItemProviders();
      const items = yield* providers[0].provideCellStatusBarItems(cell);
      const stalenessItem = items.find((item) => item.text.includes("Stale"));

      expect(stalenessItem).toBeDefined();
      expect(stalenessItem?.text).toContain("Stale");
      expect(stalenessItem?.tooltip).toContain("edited but not re-executed");
      expect(stalenessItem?.command).toEqual({
        command: commandId(runStale.command),
        title: "Run stale cells",
        arguments: [cell],
      });
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "should not show name for default cell name",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const cell = createMockCell(notebookUri, { marimo: { name: "_" } });
      const providers = yield* ctx.vscode.getRegisteredStatusBarItemProviders();
      const items = yield* providers[1].provideCellStatusBarItems(cell);
      expect(items.length).toBe(0);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "should show custom cell name",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const cell = createMockCell(notebookUri, {
        marimo: { name: "my_custom_cell" },
      });
      const providers = yield* ctx.vscode.getRegisteredStatusBarItemProviders();
      const items = yield* providers[1].provideCellStatusBarItems(cell);

      expect(items[0]).toBeDefined();
      expect(items[0]?.text).toContain("my_custom_cell");
      expect(items[0]?.tooltip).toContain("Cell name: my_custom_cell");
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "should show setup cell with gear icon",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const cell = createMockCell(notebookUri, {
        marimo: { name: "setup" },
      });
      const providers = yield* ctx.vscode.getRegisteredStatusBarItemProviders();
      const items = yield* providers[1].provideCellStatusBarItems(cell);

      expect(items[0]).toBeDefined();
      expect(items[0]?.text).toContain("$(gear)");
      expect(items[0]?.text).toContain("setup");
      expect(items[0]?.tooltip).toContain("Setup cell");
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "should handle cell with no metadata",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const cell = createMockCell(notebookUri);
      const providers = yield* ctx.vscode.getRegisteredStatusBarItemProviders();
      // Name provider should return empty for cells without metadata
      const items = yield* providers[1].provideCellStatusBarItems(cell);
      expect(items.length).toBe(0);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "should handle both staleness and name simultaneously",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const executions = yield* CellExecutions;
      const cell = createMockCell(notebookUri, {
        marimo: { name: "my_cell" },
        marimoRuntime: { stableId: "cell-2" },
      });

      // Execute then invalidate → stale + shows name
      yield* executions.recordExecution(MarimoNotebookCell.from(cell));
      yield* executions.invalidateCell(MarimoNotebookCell.from(cell));

      const providers = yield* ctx.vscode.getRegisteredStatusBarItemProviders();

      const stalenessItems =
        yield* providers[0].provideCellStatusBarItems(cell);
      expect(stalenessItems.some((item) => item.text.includes("Stale"))).toBe(
        true,
      );

      const nameItems = yield* providers[1].provideCellStatusBarItems(cell);
      expect(nameItems.some((item) => item.text.includes("my_cell"))).toBe(
        true,
      );
    }).pipe(Effect.provide(ctx.layer));
  }),
);
