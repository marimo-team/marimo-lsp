import { assert, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type * as vscode from "vscode";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import { makeTestMarimoClient } from "../../__tests__/__utils__/TestMarimoClient.ts";
import * as CellMetadataUIBinding from "../../notebook/CellMetadataUIBinding.ts";
import * as NotebookDatasources from "../../panel/datasources/NotebookDatasources.ts";
import * as Constants from "../../platform/Constants.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import type * as Api from "../../schemas/Models.gen.ts";
import * as CellMetadataBindings from "../CellMetadataBindings.ts";

const it = EffectTest.make(
  Layer.empty.pipe(
    Layer.provideMerge(CellMetadataBindings.layer),
    Layer.provide(CellMetadataUIBinding.layer),
    Layer.provide(NotebookDatasources.defaultLayer),
    Layer.provide(makeTestMarimoClient()),
    Layer.provide(Constants.defaultLayer),
    Layer.provideMerge(TestVsCode.layer),
  ),
);

const notebookUri = TestVsCode.createNotebookUri("file:///test/notebook_mo.py");

// Mock cell factory
function createMockCell(
  uri: vscode.Uri,
  languageId: string = "python",
  metadata: typeof Api.CellMetadata.Encoded = {},
) {
  return TestVsCode.createNotebookCell(
    TestVsCode.createTestNotebookDocument(uri),
    {
      kind: 1, // Code
      value: "SELECT * FROM table",
      languageId,
      metadata: MarimoNotebookCell.createMetadata(metadata),
    },
    0,
  );
}

it.effect("should register SQL dataframeName binding", () =>
  Effect.gen(function* () {
    const vscode = yield* TestVsCode.Service;
    const providers = yield* vscode.statusBarProviders;
    expect(providers.length).toBeGreaterThan(0);
  }),
);

it.effect("should only show SQL dataframeName binding for SQL cells", () =>
  Effect.gen(function* () {
    const vscode = yield* TestVsCode.Service;
    const sqlCell = createMockCell(notebookUri, "sql", {});
    const pythonCell = createMockCell(notebookUri, "python", {});
    const providers = yield* vscode.statusBarProviders;
    const provider = providers[0];
    assert(provider !== undefined);

    const sqlItems = yield* provider.provideCellStatusBarItems(sqlCell);
    expect(sqlItems.length).toBeGreaterThan(0);

    const pythonItems = yield* provider.provideCellStatusBarItems(pythonCell);
    expect(pythonItems.length).toBe(0);
  }),
);

it.effect("should display dataframeName from SQL metadata", () =>
  Effect.gen(function* () {
    const vscode = yield* TestVsCode.Service;
    const cell = createMockCell(notebookUri, "sql", {
      marimo: {
        sourceProjections: {
          markdown: null,
          sql: {
            dataframeName: "my_results",
            quotePrefix: "",
            commentLines: [],
            showOutput: true,
            engine: CellMetadataBindings.defaultSqlEngine,
          },
        },
      },
    });

    const providers = yield* vscode.statusBarProviders;
    const provider = providers[0];
    assert(provider !== undefined);
    const items = yield* provider.provideCellStatusBarItems(cell);

    expect(items.length).toBe(1);
    expect(items[0]?.text).toContain("$(table)");
    expect(items[0]?.text).toContain("my_results");
  }),
);

it.effect("should show 'unnamed' for SQL cells without dataframeName", () =>
  Effect.gen(function* () {
    const vscode = yield* TestVsCode.Service;
    const cell = createMockCell(notebookUri, "sql", {});

    const providers = yield* vscode.statusBarProviders;
    const provider = providers[0];
    assert(provider !== undefined);
    const items = yield* provider.provideCellStatusBarItems(cell);

    expect(items.length).toBe(1);
    expect(items[0]?.text).toContain("$(table)");
    expect(items[0]?.text).toContain("unnamed");
  }),
);
