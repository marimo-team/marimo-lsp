import * as Vitest from "@effect/vitest";
import { Effect, Layer } from "effect";
import type * as vscode from "vscode";

import * as MarimoClientTest from "../../__tests__/fake/MarimoClient.ts";
import * as VsCodeTest from "../../__tests__/fake/VsCode.ts";
import * as EffectTest from "../../__tests__/lib/EffectTest.ts";
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
    Layer.provide(MarimoClientTest.layerWith()),
    Layer.provide(Constants.defaultLayer),
    Layer.provideMerge(VsCodeTest.layer),
  ),
);

const notebookUri = VsCodeTest.createNotebookUri("file:///test/notebook_mo.py");

// Mock cell factory
function createMockCell(
  uri: vscode.Uri,
  languageId: string = "python",
  metadata: typeof Api.CellMetadata.Encoded = {},
) {
  return VsCodeTest.createNotebookCell(
    VsCodeTest.createTestNotebookDocument(uri),
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
    const vscode = yield* VsCodeTest.Service;
    const providers = yield* vscode.statusBarProviders;
    Vitest.expect(providers.length).toBeGreaterThan(0);
  }),
);

it.effect("should only show SQL dataframeName binding for SQL cells", () =>
  Effect.gen(function* () {
    const vscode = yield* VsCodeTest.Service;
    const sqlCell = createMockCell(notebookUri, "sql", {});
    const pythonCell = createMockCell(notebookUri, "python", {});
    const providers = yield* vscode.statusBarProviders;
    const provider = providers[0];
    Vitest.assert(provider !== undefined);

    const sqlItems = yield* provider.provideCellStatusBarItems(sqlCell);
    Vitest.expect(sqlItems.length).toBeGreaterThan(0);

    const pythonItems = yield* provider.provideCellStatusBarItems(pythonCell);
    Vitest.expect(pythonItems.length).toBe(0);
  }),
);

it.effect("should display dataframeName from SQL metadata", () =>
  Effect.gen(function* () {
    const vscode = yield* VsCodeTest.Service;
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
    Vitest.assert(provider !== undefined);
    const items = yield* provider.provideCellStatusBarItems(cell);

    Vitest.expect(items.length).toBe(1);
    Vitest.expect(items[0]?.text).toContain("$(table)");
    Vitest.expect(items[0]?.text).toContain("my_results");
  }),
);

it.effect("should show 'unnamed' for SQL cells without dataframeName", () =>
  Effect.gen(function* () {
    const vscode = yield* VsCodeTest.Service;
    const cell = createMockCell(notebookUri, "sql", {});

    const providers = yield* vscode.statusBarProviders;
    const provider = providers[0];
    Vitest.assert(provider !== undefined);
    const items = yield* provider.provideCellStatusBarItems(cell);

    Vitest.expect(items.length).toBe(1);
    Vitest.expect(items[0]?.text).toContain("$(table)");
    Vitest.expect(items[0]?.text).toContain("unnamed");
  }),
);
