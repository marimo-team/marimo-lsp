import type * as vscode from "vscode";

import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import type { CellMetadata } from "../../schemas.ts";

import {
  createNotebookCell,
  createNotebookUri,
  createTestNotebookDocument,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { CellMetadataUIBindingService } from "../../services/CellMetadataUIBindingService.ts";
import { Constants } from "../../services/Constants.ts";
import { DatasourcesService } from "../../services/datasources/DatasourcesService.ts";
import {
  CellMetadataBindingsLive,
  DEFAULT_SQL_ENGINE,
} from "../CellMetadataBindings.ts";

const withTestCtx = Effect.gen(function* () {
  const vscode = yield* TestVsCode.make();
  const layer = Layer.empty.pipe(
    Layer.provideMerge(CellMetadataBindingsLive),
    Layer.provide(CellMetadataUIBindingService.Default),
    Layer.provide(DatasourcesService.Default),
    Layer.provide(Constants.Default),
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
      value: "SELECT * FROM table",
      languageId,
      metadata,
    },
    0,
  );
}

it.effect("should register SQL dataframeName binding", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* withTestCtx;
      yield* Effect.gen(function* () {
        const providers =
          yield* ctx.vscode.getRegisteredStatusBarItemProviders();
        expect(providers.length).toBeGreaterThan(0);
      }).pipe(Effect.provide(ctx.layer));
    }),
  ),
);

it.effect("should only show SQL dataframeName binding for SQL cells", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* withTestCtx;
      yield* Effect.gen(function* () {
        const sqlCell = createMockCell(notebookUri, "sql", {});
        const pythonCell = createMockCell(notebookUri, "python", {});

        const providers =
          yield* ctx.vscode.getRegisteredStatusBarItemProviders();
        const provider = providers[0]?.provider;

        if (provider) {
          const sqlItems = provider.provideCellStatusBarItems(
            sqlCell,
            noopToken,
          );
          const sqlArray = Array.isArray(sqlItems) ? sqlItems : [];
          expect(sqlArray.length).toBeGreaterThan(0);

          const pythonItems = provider.provideCellStatusBarItems(
            pythonCell,
            noopToken,
          );
          const pythonArray = Array.isArray(pythonItems) ? pythonItems : [];
          expect(pythonArray.length).toBe(0);
        }
      }).pipe(Effect.provide(ctx.layer));
    }),
  ),
);

it.effect("should display dataframeName from SQL metadata", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* withTestCtx;
      yield* Effect.gen(function* () {
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
        const provider = providers[0]?.provider;

        if (provider) {
          const items = provider.provideCellStatusBarItems(cell, noopToken);
          const itemArray = Array.isArray(items) ? items : [];

          expect(itemArray.length).toBe(1);
          expect(itemArray[0]?.text).toContain("$(table)");
          expect(itemArray[0]?.text).toContain("my_results");
        }
      }).pipe(Effect.provide(ctx.layer));
    }),
  ),
);

it.effect("should show 'unnamed' for SQL cells without dataframeName", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* withTestCtx;
      yield* Effect.gen(function* () {
        const cell = createMockCell(notebookUri, "sql", {});

        const providers =
          yield* ctx.vscode.getRegisteredStatusBarItemProviders();
        const provider = providers[0]?.provider;

        if (provider) {
          const items = provider.provideCellStatusBarItems(cell, noopToken);
          const itemArray = Array.isArray(items) ? items : [];

          expect(itemArray.length).toBe(1);
          expect(itemArray[0]?.text).toContain("$(table)");
          expect(itemArray[0]?.text).toContain("unnamed");
        }
      }).pipe(Effect.provide(ctx.layer));
    }),
  ),
);
