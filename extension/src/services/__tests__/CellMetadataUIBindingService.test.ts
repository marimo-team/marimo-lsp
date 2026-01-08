import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type * as vscode from "vscode";
import {
  createNotebookCell,
  createNotebookUri,
  createTestNotebookDocument,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { DEFAULT_SQL_ENGINE } from "../../layers/CellMetadataBindings.ts";
import type { CellMetadata } from "../../schemas.ts";
import {
  CellMetadataUIBindingService,
  type MetadataBinding,
} from "../CellMetadataUIBindingService.ts";
import { Constants } from "../Constants.ts";

const withTestCtx = Effect.gen(function* () {
  const vscode = yield* TestVsCode.make();
  const layer = CellMetadataUIBindingService.Default.pipe(
    Layer.provideMerge(Constants.Default),
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
function createMockCell(
  uri: vscode.Uri,
  languageId: string = "python",
  metadata: Partial<CellMetadata> = {},
) {
  return createNotebookCell(
    createTestNotebookDocument(uri),
    {
      kind: 1, // Code
      value: "print('test')",
      languageId,
      metadata,
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
  Effect.fnUntraced(function* () {
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
      const provider = providers[0]?.provider;

      if (provider) {
        const sqlItems = provider.provideCellStatusBarItems(sqlCell, noopToken);
        const sqlArray = Array.isArray(sqlItems) ? sqlItems : [];
        expect(sqlArray.length).toBe(1);
        expect(sqlArray[0]?.text).toContain("$(database) df");

        const pythonItems = provider.provideCellStatusBarItems(
          pythonCell,
          noopToken,
        );
        const pythonArray = Array.isArray(pythonItems) ? pythonItems : [];
        expect(pythonArray.length).toBe(0);
      }
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
            metadata.languageMetadata?.sql?.dataframeName ?? "unnamed",
          setValue: (metadata) => ({ ...metadata }),
          getLabel: (value) => `$(database) ${value}`,
          getTooltip: () => "Tooltip",
        };

        yield* service.registerBinding(binding);

        const cell = createMockCell(notebookUri, "sql", {
          languageMetadata: {
            sql: {
              dataframeName: "my_results",
              quotePrefix: "",
              commentLines: [],
              showOutput: true,
              engine: DEFAULT_SQL_ENGINE,
            },
          },
        });

        const providers =
          yield* ctx.vscode.getRegisteredStatusBarItemProviders();
        const items = providers[0]?.provider.provideCellStatusBarItems(
          cell,
          noopToken,
        );

        const itemArray = Array.isArray(items) ? items : [];
        expect(itemArray[0]?.text).toContain("$(database) my_results");
      }).pipe(Effect.provide(ctx.layer));
    }),
  ),
);
