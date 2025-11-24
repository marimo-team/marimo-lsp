import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type * as vscode from "vscode";
import {
  createNotebookCell,
  createNotebookUri,
  createTestNotebookDocument,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { LanguageId } from "../../constants.ts";
import type { CellMetadata } from "../../schemas.ts";
import { CellStatusBarProviderLive } from "../CellStatusBarProvider.ts";

const withTestCtx = Effect.fnUntraced(function* () {
  const vscode = yield* TestVsCode.make();
  const layer = Layer.empty.pipe(
    Layer.provideMerge(CellStatusBarProviderLive),
    Layer.provide(vscode.layer),
  );
  return { vscode, layer };
});

const notebookUri = createNotebookUri("file:///test/notebook_mo.py");

const noopToken: vscode.CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
};

// Mock cell factory
function createMockCell(uri: vscode.Uri, metadata: Partial<CellMetadata> = {}) {
  return createNotebookCell(
    createTestNotebookDocument(uri),
    {
      kind: 1, // Code
      value: "",
      languageId: LanguageId.Python,
      metadata: metadata,
    },
    0,
  );
}

it.effect(
  "should register staleness provider",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx();
    yield* Effect.gen(function* () {
      // Verify that registerNotebookCellStatusBarItemProvider was called
      const registrations =
        yield* ctx.vscode.getRegisteredStatusBarItemProviders();
      expect(registrations.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "should not show staleness for fresh cell",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const uri = notebookUri;
      const cell = createMockCell(uri, { name: "test_cell", state: "idle" });

      const providers = yield* ctx.vscode.getRegisteredStatusBarItemProviders();
      const items = providers[0].provider.provideCellStatusBarItems(
        cell,
        noopToken,
      );

      // Should not have staleness item
      const itemArray = Array.isArray(items) ? items : [];
      const hasStalenessItem = itemArray.some((item) =>
        item.text.includes("Stale"),
      );

      expect(hasStalenessItem).toBe(false);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "should show staleness indicator for stale cell",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const uri = notebookUri;

      const cell = createMockCell(uri, {
        name: "test_cell",
        state: "stale",
      });

      const providers = yield* ctx.vscode.getRegisteredStatusBarItemProviders();
      const stalenessProvider = providers[0]?.provider;

      if (stalenessProvider) {
        const items = stalenessProvider.provideCellStatusBarItems(
          cell,
          noopToken,
        );
        const itemArray = Array.isArray(items) ? items : [];
        const stalenessItem = itemArray.find((item) =>
          item.text.includes("Stale"),
        );

        expect(stalenessItem).toBeDefined();
        expect(stalenessItem?.text).toContain("Stale");
        expect(stalenessItem?.tooltip).toContain("edited but not re-executed");
      }
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "should not show name for default cell name",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const cell = createMockCell(notebookUri, {
        name: "_",
      });

      const providers = yield* ctx.vscode.getRegisteredStatusBarItemProviders();
      const nameProvider = providers[1].provider;
      const items = nameProvider.provideCellStatusBarItems(cell, noopToken);
      const itemArray = Array.isArray(items) ? items : [];
      expect(itemArray.length).toBe(0);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "should show custom cell name",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const cell = createMockCell(notebookUri, {
        name: "my_custom_cell",
      });

      const providers = yield* ctx.vscode.getRegisteredStatusBarItemProviders();
      const nameProvider = providers[1]?.provider;

      if (nameProvider) {
        const items = nameProvider.provideCellStatusBarItems(cell, noopToken);
        const itemArray = Array.isArray(items) ? items : [];
        const nameItem = itemArray[0];

        expect(nameItem).toBeDefined();
        expect(nameItem?.text).toContain("my_custom_cell");
        expect(nameItem?.tooltip).toContain("Cell name: my_custom_cell");
      }
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "should show setup cell with gear icon",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const cell = createMockCell(notebookUri, {
        name: "setup",
      });

      const providers = yield* ctx.vscode.getRegisteredStatusBarItemProviders();
      const nameProvider = providers[1]?.provider;

      if (nameProvider) {
        const items = nameProvider.provideCellStatusBarItems(cell, noopToken);
        const itemArray = Array.isArray(items) ? items : [];
        const setupItem = itemArray[0];

        expect(setupItem).toBeDefined();
        expect(setupItem?.text).toContain("$(gear)");
        expect(setupItem?.text).toContain("setup");
        expect(setupItem?.tooltip).toContain("Setup cell");
      }
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "should handle cell with no metadata",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const cell = createMockCell(notebookUri);
      const providers = yield* ctx.vscode.getRegisteredStatusBarItemProviders();

      for (const { provider } of providers) {
        const items = provider.provideCellStatusBarItems(cell, noopToken);
        const itemArray = Array.isArray(items) ? items : [];
        // Should return empty array for cells without proper metadata
        expect(itemArray.length).toBe(0);
      }
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "should provide change event emitter",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const providers = yield* ctx.vscode.getRegisteredStatusBarItemProviders();

      // Both providers should have change event emitters
      for (const { provider } of providers) {
        expect(provider.onDidChangeCellStatusBarItems).toBeDefined();
        expect(typeof provider.onDidChangeCellStatusBarItems).toBe("function");
      }
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "should handle both staleness and name simultaneously",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const cell = createMockCell(notebookUri, {
        name: "my_cell",
        state: "stale",
      });

      const providers = yield* ctx.vscode.getRegisteredStatusBarItemProviders();

      // Check staleness provider
      const stalenessItems = providers[0]?.provider.provideCellStatusBarItems(
        cell,
        noopToken,
      );
      const stalenessArray = Array.isArray(stalenessItems)
        ? stalenessItems
        : [];
      expect(stalenessArray.some((item) => item.text.includes("Stale"))).toBe(
        true,
      );

      // Check name provider
      const nameItems = providers[1]?.provider.provideCellStatusBarItems(
        cell,
        {} as vscode.CancellationToken,
      );
      const nameArray = Array.isArray(nameItems) ? nameItems : [];
      expect(nameArray.some((item) => item.text.includes("my_cell"))).toBe(
        true,
      );
    }).pipe(Effect.provide(ctx.layer));
  }),
);
