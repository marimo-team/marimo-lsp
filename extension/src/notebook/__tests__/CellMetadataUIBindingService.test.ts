import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type * as vscode from "vscode";

import {
  createNotebookCell,
  createNotebookUri,
  createTestNotebookDocument,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { commandId } from "../../commands.ts";
import { MarimoCommands } from "../../commands/MarimoCommands.ts";
import { DEFAULT_SQL_ENGINE } from "../../features/CellMetadataBindings.ts";
import {
  CellMetadataUIBindingService,
  type MetadataBinding,
} from "../../notebook/CellMetadataUIBindingService.ts";
import { Constants } from "../../platform/Constants.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import type * as Api from "../../schemas/Models.gen.ts";

const withTestCtx = Effect.gen(function* () {
  const vscode = yield* TestVsCode.make();
  const layer = CellMetadataUIBindingService.Default.pipe(
    Layer.provideMerge(Constants.Default),
    Layer.provide(vscode.layer),
  );
  return { vscode, layer };
});

const notebookUri = createNotebookUri("file:///test/notebook_mo.py");

// Mock cell factory
function createMockCell(
  uri: vscode.Uri,
  languageId: string = "python",
  metadata: typeof Api.CellMetadata.Encoded = {},
) {
  return createNotebookCell(
    createTestNotebookDocument(uri),
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
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* withTestCtx;
      yield* Effect.gen(function* () {
        const service = yield* CellMetadataUIBindingService;

        const binding: MetadataBinding = {
          id: "test.field",
          type: "text",
          alignment: 1, // Left
          shouldShow: () => true,
          getValue: () => "value",
          setValue: (metadata) => ({ ...metadata }),
          getLabel: (value) => `Label: ${value}`,
          getTooltip: () => "Test tooltip",
        };

        yield* service.registerBinding(binding);

        const providers =
          yield* ctx.vscode.getRegisteredStatusBarItemProviders();
        expect(providers.length).toBeGreaterThan(0);
      }).pipe(Effect.provide(ctx.layer));
    }),
  ),
);

it.scoped(
  "should show status bar item based on shouldShow predicate",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx;
    yield* Effect.gen(function* () {
      const service = yield* CellMetadataUIBindingService;
      const { LanguageId } = yield* Constants;

      const binding: MetadataBinding = {
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

      const providers = yield* ctx.vscode.getRegisteredStatusBarItemProviders();

      const sqlItems = yield* providers[0].provideCellStatusBarItems(sqlCell);
      expect(sqlItems.length).toBe(1);
      expect(sqlItems[0]?.text).toContain("$(database) df");
      expect(sqlItems[0]?.command).toEqual({
        command: commandId(MarimoCommands.updateCellMetadata),
        title: "Update cell metadata",
        arguments: [sqlCell, "test.sql"],
      });

      const pythonItems =
        yield* providers[0].provideCellStatusBarItems(pythonCell);
      expect(pythonItems.length).toBe(0);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect("should display value from cell metadata", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* withTestCtx;
      yield* Effect.gen(function* () {
        const service = yield* CellMetadataUIBindingService;

        const binding: MetadataBinding = {
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
                engine: DEFAULT_SQL_ENGINE,
              },
            },
          },
        });

        const providers =
          yield* ctx.vscode.getRegisteredStatusBarItemProviders();
        const items = yield* providers[0].provideCellStatusBarItems(cell);
        expect(items[0]?.text).toContain("$(database) my_results");
      }).pipe(Effect.provide(ctx.layer));
    }),
  ),
);
