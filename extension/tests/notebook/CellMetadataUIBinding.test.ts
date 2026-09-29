import * as Vitest from "@effect/vitest";
import { Effect, Layer } from "effect";
import type * as vscode from "vscode";

import { commandId } from "../../src/commands.ts";
import { MarimoCommands } from "../../src/commands/MarimoCommands.ts";
import * as CellMetadataBindings from "../../src/features/CellMetadataBindings.ts";
import * as CellMetadataUIBinding from "../../src/notebook/CellMetadataUIBinding.ts";
import * as Constants from "../../src/platform/Constants.ts";
import { MarimoNotebookCell } from "../../src/schemas/MarimoNotebookDocument.ts";
import type * as Api from "../../src/schemas/Models.gen.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as EffectTest from "../lib/EffectTest.ts";

const it = EffectTest.make(
  CellMetadataUIBinding.layer.pipe(
    Layer.provideMerge(Constants.defaultLayer),
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
      value: "print('test')",
      languageId,
      metadata: MarimoNotebookCell.createMetadata(metadata),
    },
    0,
  );
}

it.effect("should register a binding and create status bar provider", () =>
  Effect.gen(function* () {
    const service = yield* CellMetadataUIBinding.Service;
    const vscode = yield* VsCodeTest.Service;

    const binding: CellMetadataUIBinding.MetadataBinding = {
      id: "test.field",
      type: "text",
      alignment: 1,
      shouldShow: () => true,
      getValue: () => "value",
      setValue: (metadata) => ({ ...metadata }),
      getLabel: (value) => `Label: ${value}`,
      getTooltip: () => "Test tooltip",
    };

    yield* service.registerBinding(binding);

    const providers = yield* vscode.statusBarProviders;
    Vitest.expect(providers.length).toBeGreaterThan(0);
  }),
);

it.effect(
  "should show status bar item based on shouldShow predicate",
  Effect.fn(function* () {
    const service = yield* CellMetadataUIBinding.Service;
    const vscode = yield* VsCodeTest.Service;
    const { LanguageId } = yield* Constants.Service;

    const binding: CellMetadataUIBinding.MetadataBinding = {
      id: "test.sql",
      type: "text",
      alignment: 1,
      shouldShow: (cell) => cell.document.languageId === LanguageId.Sql,
      getValue: () => "df",
      setValue: (metadata) => ({ ...metadata }),
      getLabel: (value) => `$(database) ${value}`,
      getTooltip: (value) => `Result: ${value}`,
    };

    yield* service.registerBinding(binding);

    const sqlCell = createMockCell(notebookUri, "sql", {});
    const pythonCell = createMockCell(notebookUri, "python", {});

    const providers = yield* vscode.statusBarProviders;
    const provider = providers[0];
    Vitest.assert(provider !== undefined);

    const sqlItems = yield* provider.provideCellStatusBarItems(sqlCell);
    Vitest.expect(sqlItems.length).toBe(1);
    Vitest.expect(sqlItems[0]?.text).toContain("$(database) df");
    Vitest.expect(sqlItems[0]?.command).toEqual({
      command: commandId(MarimoCommands.updateCellMetadata),
      title: "Update cell metadata",
      arguments: [sqlCell, "test.sql"],
    });

    const pythonItems = yield* provider.provideCellStatusBarItems(pythonCell);
    Vitest.expect(pythonItems.length).toBe(0);
  }),
);

it.effect("should display value from cell metadata", () =>
  Effect.gen(function* () {
    const service = yield* CellMetadataUIBinding.Service;
    const vscode = yield* VsCodeTest.Service;

    const binding: CellMetadataUIBinding.MetadataBinding = {
      id: "test.metadata",
      type: "text",
      alignment: 1,
      shouldShow: () => true,
      getValue: (metadata) =>
        metadata.sourceProjections?.sql?.dataframeName ?? "unnamed",
      setValue: (metadata) => ({ ...metadata }),
      getLabel: (value) => `$(database) ${value}`,
      getTooltip: () => "Tooltip",
    };

    yield* service.registerBinding(binding);

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
    Vitest.expect(items[0]?.text).toContain("$(database) my_results");
  }),
);
