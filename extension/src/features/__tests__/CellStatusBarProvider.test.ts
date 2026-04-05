import { expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";

import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import {
  createNotebookCell,
  createNotebookUri,
  createTestNotebookDocument,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { LanguageClient } from "../../lsp/LanguageClient.ts";
import { CellStateManager } from "../../notebook/CellStateManager.ts";
import type { CellMetadata } from "../../schemas/CellMetadata.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import { CellStatusBarProviderLive } from "../CellStatusBarProvider.ts";

const withTestCtx = Effect.fn(function* () {
  const vscode = yield* TestVsCode.make();
  const layer = Layer.empty.pipe(
    Layer.provideMerge(CellStatusBarProviderLive),
    Layer.provideMerge(CellStateManager.Default),
    Layer.provideMerge(vscode.layer),
    Layer.provide(TestTelemetryLive),
    Layer.provide(
      Layer.succeed(
        LanguageClient,
        LanguageClient.make({
          channel: { name: "marimo-lsp", show() {} },
          restart: () => Effect.void,
          executeCommand: () => Effect.void,
          streamOf: () => Stream.never,
        }),
      ),
    ),
  );
  return { vscode, layer };
});

const notebookUri = createNotebookUri("file:///test/notebook_mo.py");

function createMockCell(
  uri: ReturnType<typeof createNotebookUri>,
  metadata: Partial<CellMetadata> = {},
) {
  return createNotebookCell(
    createTestNotebookDocument(uri),
    { kind: 1, value: "", languageId: "python", metadata },
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
        name: "test_cell",
        stableId: "cell-1",
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
      const cellStateManager = yield* CellStateManager;
      const cell = createMockCell(notebookUri, {
        name: "test_cell",
        stableId: "cell-1",
      });

      // Record execution — clears stale
      yield* cellStateManager.recordExecution(MarimoNotebookCell.from(cell));

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
      const cellStateManager = yield* CellStateManager;
      const cell = createMockCell(notebookUri, {
        name: "test_cell",
        stableId: "cell-1",
      });

      // Execute then invalidate (simulates staleInputs from kernel)
      yield* cellStateManager.recordExecution(MarimoNotebookCell.from(cell));
      yield* cellStateManager.invalidateCell(MarimoNotebookCell.from(cell));

      const providers = yield* ctx.vscode.getRegisteredStatusBarItemProviders();
      const items = yield* providers[0].provideCellStatusBarItems(cell);
      const stalenessItem = items.find((item) => item.text.includes("Stale"));

      expect(stalenessItem).toBeDefined();
      expect(stalenessItem?.text).toContain("Stale");
      expect(stalenessItem?.tooltip).toContain("edited but not re-executed");
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "should not show name for default cell name",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const cell = createMockCell(notebookUri, { name: "_" });
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
      const cell = createMockCell(notebookUri, { name: "my_custom_cell" });
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
      const cell = createMockCell(notebookUri, { name: "setup" });
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
      const cellStateManager = yield* CellStateManager;
      const cell = createMockCell(notebookUri, {
        name: "my_cell",
        stableId: "cell-2",
      });

      // Execute then invalidate → stale + shows name
      yield* cellStateManager.recordExecution(MarimoNotebookCell.from(cell));
      yield* cellStateManager.invalidateCell(MarimoNotebookCell.from(cell));

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
