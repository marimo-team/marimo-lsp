import type * as vscode from "vscode";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  createNotebookCell,
  createNotebookUri,
  createTestNotebookDocument,
} from "../../__mocks__/TestVsCode.ts";
import { type CellMetadata, MarimoNotebookCell } from "../../schemas.ts";
import { Constants } from "../../services/Constants.ts";
import { getCellExecutableCode } from "../getCellExecutableCode.ts";

const notebookUri = createNotebookUri("file:///test/notebook_mo.py");

// Helper to create a mock cell with proper MarimoNotebookCell wrapping
function createMockCell(
  uri: vscode.Uri,
  languageId: string,
  value: string,
  metadata: Partial<CellMetadata> = {},
) {
  const rawCell = createNotebookCell(
    createTestNotebookDocument(uri),
    {
      kind: 2, // Code
      value,
      languageId,
      metadata,
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
        languageMetadata: {
          sql: {
            dataframeName: "my_results",
            quotePrefix: "f",
            commentLines: [],
            showOutput: true,
            engine: "__marimo_duckdb",
          },
        },
        stableId: "test-cell-id",
      });

      const code = getCellExecutableCode(cell, LanguageId);

      // Should contain the custom dataframe name
      expect(code).toContain("my_results = mo.sql(");
      // Should not use default _df
      expect(code).not.toContain("_df = mo.sql(");
    }).pipe(Effect.provide(Constants.Default)),
  );

  it.effect("should use default metadata when SQL cell has no metadata", () =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants;

      const cell = createMockCell(notebookUri, "sql", "SELECT * FROM users", {
        stableId: "test-cell-id",
        // No languageMetadata.sql
      });

      const code = getCellExecutableCode(cell, LanguageId);

      // Should use default _df when no metadata
      expect(code).toContain("_df = mo.sql(");
    }).pipe(Effect.provide(Constants.Default)),
  );

  it.effect("should pass through Python cells unchanged", () =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants;

      const pythonCode = "x = 1 + 2";
      const cell = createMockCell(notebookUri, "python", pythonCode, {
        stableId: "test-cell-id",
      });

      const code = getCellExecutableCode(cell, LanguageId);

      expect(code).toBe(pythonCode);
    }).pipe(Effect.provide(Constants.Default)),
  );

  it.effect("should handle SQL metadata with output=False", () =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants;

      const cell = createMockCell(notebookUri, "sql", "CREATE TABLE test", {
        languageMetadata: {
          sql: {
            dataframeName: "result",
            quotePrefix: "f",
            commentLines: [],
            showOutput: false,
            engine: "__marimo_duckdb",
          },
        },
        stableId: "test-cell-id",
      });

      const code = getCellExecutableCode(cell, LanguageId);

      expect(code).toContain("result = mo.sql(");
      expect(code).toContain("output=False");
    }).pipe(Effect.provide(Constants.Default)),
  );

  it.effect("should handle SQL metadata with custom engine", () =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants;

      const cell = createMockCell(notebookUri, "sql", "SELECT 1", {
        languageMetadata: {
          sql: {
            dataframeName: "df",
            quotePrefix: "f",
            commentLines: [],
            showOutput: true,
            engine: "postgres_conn",
          },
        },
        stableId: "test-cell-id",
      });

      const code = getCellExecutableCode(cell, LanguageId);

      expect(code).toContain("df = mo.sql(");
      expect(code).toContain("engine=postgres_conn");
    }).pipe(Effect.provide(Constants.Default)),
  );
});
