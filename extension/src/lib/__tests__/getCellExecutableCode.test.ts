import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type * as vscode from "vscode";

import {
  createNotebookCell,
  createNotebookUri,
  createTestNotebookDocument,
} from "../../__mocks__/TestVsCode.ts";
import { Constants } from "../../platform/Constants.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import type * as Api from "../../schemas/Models.gen.ts";
import { getCellExecutableCode } from "../getCellExecutableCode.ts";

const notebookUri = createNotebookUri("file:///test/notebook_mo.py");

// Helper to create a mock cell with proper MarimoNotebookCell wrapping
function createMockCell(
  uri: vscode.Uri,
  languageId: string,
  value: string,
  metadata: typeof Api.CellMetadata.Encoded = {},
) {
  const rawCell = createNotebookCell(
    createTestNotebookDocument(uri),
    {
      kind: 2, // Code
      value,
      languageId,
      metadata: MarimoNotebookCell.createMetadata(metadata),
    },
    0,
  );
  return MarimoNotebookCell.from(rawCell);
}

describe("getCellExecutableCode", () => {
  it.effect("should transform SQL cell with custom dataframe name", () =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants;

      const cell = createMockCell(notebookUri, "sql", "SELECT * FROM users", {
        marimo: {
          sourceProjections: {
            markdown: null,
            sql: {
              dataframeName: "my_results",
              quotePrefix: "f",
              commentLines: [],
              showOutput: true,
              engine: "__marimo_duckdb",
            },
          },
        },
        marimoRuntime: { stableId: "test-cell-id" },
      });

      const code = getCellExecutableCode(cell, LanguageId);

      // Should contain the custom dataframe name
      expect(code).toContain("my_results = mo.sql(");
      // Should not use default _df
      expect(code).not.toContain("_df = mo.sql(");
    }).pipe(Effect.provide(Constants.layer)),
  );

  it.effect("should use default metadata when SQL cell has no metadata", () =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants;

      const cell = createMockCell(notebookUri, "sql", "SELECT * FROM users", {
        marimoRuntime: { stableId: "test-cell-id" },
        // No sourceProjections.sql
      });

      const code = getCellExecutableCode(cell, LanguageId);

      // Should use default _df when no metadata
      expect(code).toContain("_df = mo.sql(");
    }).pipe(Effect.provide(Constants.layer)),
  );

  it.effect("should pass through Python cells unchanged", () =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants;

      const pythonCode = "x = 1 + 2";
      const cell = createMockCell(notebookUri, "python", pythonCode, {
        marimoRuntime: { stableId: "test-cell-id" },
      });

      const code = getCellExecutableCode(cell, LanguageId);

      expect(code).toBe(pythonCode);
    }).pipe(Effect.provide(Constants.layer)),
  );

  it.effect("should handle SQL metadata with output=False", () =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants;

      const cell = createMockCell(notebookUri, "sql", "CREATE TABLE test", {
        marimo: {
          sourceProjections: {
            markdown: null,
            sql: {
              dataframeName: "result",
              quotePrefix: "f",
              commentLines: [],
              showOutput: false,
              engine: "__marimo_duckdb",
            },
          },
        },
        marimoRuntime: { stableId: "test-cell-id" },
      });

      const code = getCellExecutableCode(cell, LanguageId);

      expect(code).toContain("result = mo.sql(");
      expect(code).toContain("output=False");
    }).pipe(Effect.provide(Constants.layer)),
  );

  it.effect("should handle SQL metadata with custom engine", () =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants;

      const cell = createMockCell(notebookUri, "sql", "SELECT 1", {
        marimo: {
          sourceProjections: {
            markdown: null,
            sql: {
              dataframeName: "df",
              quotePrefix: "f",
              commentLines: [],
              showOutput: true,
              engine: "postgres_conn",
            },
          },
        },
        marimoRuntime: { stableId: "test-cell-id" },
      });

      const code = getCellExecutableCode(cell, LanguageId);

      expect(code).toContain("df = mo.sql(");
      expect(code).toContain("engine=postgres_conn");
    }).pipe(Effect.provide(Constants.layer)),
  );
});
