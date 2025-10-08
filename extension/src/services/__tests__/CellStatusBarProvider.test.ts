import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type * as vscode from "vscode";
import {
  createNotebookCell,
  createTestNotebookDocument,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import type { CellMetadata } from "../../schemas.ts";
import { CellStatusBarProvider } from "../CellStatusBarProvider.ts";

function makeCellStatusBarProviderLayer(testVsCode: TestVsCode) {
  return Layer.empty.pipe(
    Layer.provideMerge(CellStatusBarProvider.Default),
    Layer.provide(testVsCode.layer),
  );
}

const notebookUri = undefined!;

// Mock cell factory
function createMockCell(uri: vscode.Uri, metadata: Partial<CellMetadata> = {}) {
  return createNotebookCell(
    createTestNotebookDocument(uri),
    {
      kind: 1, // Code
      value: "",
      languageId: "python",
      metadata: metadata,
    },
    0,
  );
}

it.effect(
  "should build successfully",
  Effect.fnUntraced(function* () {
    const testVsCode = yield* TestVsCode.make();
    yield* Effect.provide(
      Effect.gen(function* () {
        const provider = yield* CellStatusBarProvider;
        expect(provider).toBeDefined();
        expect(typeof provider.dispose).toBe("function");
      }),
      makeCellStatusBarProviderLayer(testVsCode),
    );
  }),
);

it.effect(
  "should register staleness provider",
  Effect.fnUntraced(function* () {
    const testVsCode = yield* TestVsCode.make();
    yield* Effect.provide(
      Effect.gen(function* () {
        const _provider = yield* CellStatusBarProvider;

        // Verify that registerNotebookCellStatusBarItemProvider was called
        const registrations =
          yield* testVsCode.getRegisteredStatusBarItemProviders();
        expect(registrations.length).toBeGreaterThan(0);
      }),
      makeCellStatusBarProviderLayer(testVsCode),
    );
  }),
);

it.effect(
  "should not show staleness for fresh cell",
  Effect.fnUntraced(function* () {
    const testVsCode = yield* TestVsCode.make();
    yield* Effect.provide(
      Effect.gen(function* () {
        yield* CellStatusBarProvider;
        // const code = yield* VsCode;
        // const uri = code.Uri.file("/test/notebook_mo.py");
        const uri = notebookUri;
        const cell = createMockCell(uri, {
          name: "test_cell",
          state: "idle",
        });

        const providers =
          yield* testVsCode.getRegisteredStatusBarItemProviders();
        const items = providers[0]?.provider.provideCellStatusBarItems(
          cell,
          {} as vscode.CancellationToken,
        );

        // Should not have staleness item
        const itemArray = Array.isArray(items) ? items : [];
        const hasStalenessItem = itemArray.some((item) =>
          item.text.includes("Stale"),
        );
        expect(hasStalenessItem).toBe(false);
      }),
      makeCellStatusBarProviderLayer(testVsCode),
    );
  }),
);

it.effect(
  "should show staleness indicator for stale cell",
  Effect.fnUntraced(function* () {
    const testVsCode = yield* TestVsCode.make();
    yield* Effect.provide(
      Effect.gen(function* () {
        yield* CellStatusBarProvider;

        // const code = yield* VsCode;
        // const uri = code.Uri.file("/test/notebook_mo.py");
        const uri = notebookUri;

        const cell = createMockCell(uri, {
          name: "test_cell",
          state: "stale",
        });

        const providers =
          yield* testVsCode.getRegisteredStatusBarItemProviders();
        const stalenessProvider = providers[0]?.provider;

        if (stalenessProvider) {
          const items = stalenessProvider.provideCellStatusBarItems(
            cell,
            {} as vscode.CancellationToken,
          );
          const itemArray = Array.isArray(items) ? items : [];
          const stalenessItem = itemArray.find((item) =>
            item.text.includes("Stale"),
          );

          expect(stalenessItem).toBeDefined();
          expect(stalenessItem?.text).toContain("Stale");
          expect(stalenessItem?.tooltip).toContain(
            "edited but not re-executed",
          );
        }
      }),
      makeCellStatusBarProviderLayer(testVsCode),
    );
  }),
);

it.effect(
  "should not show name for default cell name",
  Effect.fnUntraced(function* () {
    const testVsCode = yield* TestVsCode.make();
    yield* Effect.provide(
      Effect.gen(function* () {
        yield* CellStatusBarProvider;

        const cell = createMockCell(notebookUri, {
          name: "_",
        });

        const providers =
          yield* testVsCode.getRegisteredStatusBarItemProviders();
        const nameProvider = providers[1]?.provider;

        if (nameProvider) {
          const items = nameProvider.provideCellStatusBarItems(cell, {} as any);
          const itemArray = Array.isArray(items) ? items : [];
          expect(itemArray.length).toBe(0);
        }
      }),
      makeCellStatusBarProviderLayer(testVsCode),
    );
  }),
);

it.effect(
  "should show custom cell name",
  Effect.fnUntraced(function* () {
    const testVsCode = yield* TestVsCode.make();
    yield* Effect.provide(
      Effect.gen(function* () {
        yield* CellStatusBarProvider;

        const cell = createMockCell(notebookUri, {
          name: "my_custom_cell",
        });

        const providers =
          yield* testVsCode.getRegisteredStatusBarItemProviders();
        const nameProvider = providers[1]?.provider;

        if (nameProvider) {
          const items = nameProvider.provideCellStatusBarItems(cell, {} as any);
          const itemArray = Array.isArray(items) ? items : [];
          const nameItem = itemArray[0];

          expect(nameItem).toBeDefined();
          expect(nameItem?.text).toContain("my_custom_cell");
          expect(nameItem?.tooltip).toContain("Cell name: my_custom_cell");
        }
      }),
      makeCellStatusBarProviderLayer(testVsCode),
    );
  }),
);

it.effect(
  "should show setup cell with gear icon",
  Effect.fnUntraced(function* () {
    const testVsCode = yield* TestVsCode.make();
    yield* Effect.provide(
      Effect.gen(function* () {
        yield* CellStatusBarProvider;

        const cell = createMockCell(notebookUri, {
          name: "setup",
        });

        const providers =
          yield* testVsCode.getRegisteredStatusBarItemProviders();
        const nameProvider = providers[1]?.provider;

        if (nameProvider) {
          const items = nameProvider.provideCellStatusBarItems(cell, {} as any);
          const itemArray = Array.isArray(items) ? items : [];
          const setupItem = itemArray[0];

          expect(setupItem).toBeDefined();
          expect(setupItem?.text).toContain("$(gear)");
          expect(setupItem?.text).toContain("setup");
          expect(setupItem?.tooltip).toContain("Setup cell");
        }
      }),
      makeCellStatusBarProviderLayer(testVsCode),
    );
  }),
);

it.effect(
  "should handle cell with no metadata",
  Effect.fnUntraced(function* () {
    const testVsCode = yield* TestVsCode.make();
    yield* Effect.provide(
      Effect.gen(function* () {
        yield* CellStatusBarProvider;

        const cell = createMockCell(notebookUri);

        const providers =
          yield* testVsCode.getRegisteredStatusBarItemProviders();

        for (const { provider } of providers) {
          const items = provider.provideCellStatusBarItems(cell, {} as any);
          const itemArray = Array.isArray(items) ? items : [];
          // Should return empty array for cells without proper metadata
          expect(itemArray.length).toBe(0);
        }
      }),
      makeCellStatusBarProviderLayer(testVsCode),
    );
  }),
);

it.effect(
  "should provide change event emitter",
  Effect.fnUntraced(function* () {
    const testVsCode = yield* TestVsCode.make();
    yield* Effect.provide(
      Effect.gen(function* () {
        yield* CellStatusBarProvider;

        const providers =
          yield* testVsCode.getRegisteredStatusBarItemProviders();

        // Both providers should have change event emitters
        for (const { provider } of providers) {
          expect(provider.onDidChangeCellStatusBarItems).toBeDefined();
          expect(typeof provider.onDidChangeCellStatusBarItems).toBe(
            "function",
          );
        }
      }),
      makeCellStatusBarProviderLayer(testVsCode),
    );
  }),
);

it.effect(
  "should handle both staleness and name simultaneously",
  Effect.fnUntraced(function* () {
    const testVsCode = yield* TestVsCode.make();
    yield* Effect.provide(
      Effect.gen(function* () {
        yield* CellStatusBarProvider;

        const cell = createMockCell(notebookUri, {
          name: "my_cell",
          state: "stale",
        });

        const providers =
          yield* testVsCode.getRegisteredStatusBarItemProviders();

        // Check staleness provider
        const stalenessItems = providers[0]?.provider.provideCellStatusBarItems(
          cell,
          {} as vscode.CancellationToken,
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
      }),
      makeCellStatusBarProviderLayer(testVsCode),
    );
  }),
);
