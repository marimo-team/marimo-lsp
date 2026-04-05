import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type * as vscode from "vscode";

import {
  createNotebookCell,
  createNotebookUri,
  createTestNotebookDocument,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { CellMetadataUIBindingService } from "../../notebook/CellMetadataUIBindingService.ts";
import { DatasourcesService } from "../../panel/datasources/DatasourcesService.ts";
import { Constants } from "../../platform/Constants.ts";
import type { CellMetadata } from "../../schemas/CellMetadata.ts";
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

        const sqlItems = yield* providers[0].provideCellStatusBarItems(sqlCell);
        expect(sqlItems.length).toBeGreaterThan(0);

        const pythonItems =
          yield* providers[0].provideCellStatusBarItems(pythonCell);
        expect(pythonItems.length).toBe(0);
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
        const items = yield* providers[0].provideCellStatusBarItems(cell);

        expect(items.length).toBe(1);
        expect(items[0]?.text).toContain("$(table)");
        expect(items[0]?.text).toContain("my_results");
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
        const items = yield* providers[0].provideCellStatusBarItems(cell);

        expect(items.length).toBe(1);
        expect(items[0]?.text).toContain("$(table)");
        expect(items[0]?.text).toContain("unnamed");
      }).pipe(Effect.provide(ctx.layer));
    }),
  ),
);
