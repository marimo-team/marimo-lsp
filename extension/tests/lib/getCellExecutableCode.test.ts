import * as Vitest from "@effect/vitest";
import { Effect } from "effect";
import type * as vscode from "vscode";

import { getCellExecutableCode } from "../../src/lib/getCellExecutableCode.ts";
import * as Constants from "../../src/platform/Constants.ts";
import { MarimoNotebookCell } from "../../src/schemas/MarimoNotebookDocument.ts";
import type * as Api from "../../src/schemas/Models.gen.ts";
import * as VsCodeValues from "../fake/VsCodeValues.ts";
import * as EffectTest from "./EffectTest.ts";

const notebookUri = VsCodeValues.createNotebookUri(
  "file:///test/notebook_mo.py",
);
const effectIt = EffectTest.make(Constants.defaultLayer);

// Helper to create a mock cell with proper MarimoNotebookCell wrapping
function createMockCell(
  uri: vscode.Uri,
  languageId: string,
  value: string,
  metadata: typeof Api.CellMetadata.Encoded = {},
) {
  const rawCell = VsCodeValues.createNotebookCell(
    VsCodeValues.createTestNotebookDocument(uri),
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

Vitest.describe("getCellExecutableCode", () => {
  effectIt.effect("should transform SQL cell with custom dataframe name", () =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants.Service;

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
      Vitest.expect(code).toContain("my_results = mo.sql(");
      // Should not use default _df
      Vitest.expect(code).not.toContain("_df = mo.sql(");
    }),
  );

  effectIt.effect(
    "should use default metadata when SQL cell has no metadata",
    () =>
      Effect.gen(function* () {
        const { LanguageId } = yield* Constants.Service;

        const cell = createMockCell(notebookUri, "sql", "SELECT * FROM users", {
          marimoRuntime: { stableId: "test-cell-id" },
          // No sourceProjections.sql
        });

        const code = getCellExecutableCode(cell, LanguageId);

        // Should use default _df when no metadata
        Vitest.expect(code).toContain("_df = mo.sql(");
      }),
  );

  effectIt.effect("should pass through Python cells unchanged", () =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants.Service;

      const pythonCode = "x = 1 + 2";
      const cell = createMockCell(notebookUri, "python", pythonCode, {
        marimoRuntime: { stableId: "test-cell-id" },
      });

      const code = getCellExecutableCode(cell, LanguageId);

      Vitest.expect(code).toBe(pythonCode);
    }),
  );

  effectIt.effect("should handle SQL metadata with output=False", () =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants.Service;

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

      Vitest.expect(code).toContain("result = mo.sql(");
      Vitest.expect(code).toContain("output=False");
    }),
  );

  effectIt.effect("should handle SQL metadata with custom engine", () =>
    Effect.gen(function* () {
      const { LanguageId } = yield* Constants.Service;

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

      Vitest.expect(code).toContain("df = mo.sql(");
      Vitest.expect(code).toContain("engine=postgres_conn");
    }),
  );
});
