import { Brand, Effect, Layer, Option } from "effect";
import { LanguageId } from "../constants.ts";
import type { CellMetadata } from "../schemas.ts";
import { CellMetadataUIBindingService } from "../services/CellMetadataUIBindingService.ts";
import { DatasourcesService } from "../services/datasources/DatasourcesService.ts";
import { VsCode } from "../services/VsCode.ts";
import type { NotebookUri } from "../types.ts";

const DEFAULT_ENGINE = "__marimo_duckdb";
const DEFAULT_LABEL = "duckdb (In-Memory)";

/**
 * Layer that registers all cell metadata UI bindings.
 *
 * Currently includes:
 * - SQL dataframeName: Edit the dataframe variable name for SQL cells
 * - SQL showOutput: Toggle visibility of SQL query output
 * - SQL engine: Select the database connection/engine for SQL queries
 */
/**
 * Helper to update SQL metadata with defaults for all required fields
 */
function updateSqlMetadata(
  metadata: CellMetadata,
  updates: Partial<NonNullable<CellMetadata["languageMetadata"]>["sql"]>,
): CellMetadata {
  return {
    ...metadata,
    languageMetadata: {
      ...metadata.languageMetadata,
      sql: {
        dataframeName: metadata.languageMetadata?.sql?.dataframeName ?? "df",
        quotePrefix: metadata.languageMetadata?.sql?.quotePrefix ?? "",
        commentLines: metadata.languageMetadata?.sql?.commentLines ?? [],
        showOutput: metadata.languageMetadata?.sql?.showOutput ?? true,
        engine: metadata.languageMetadata?.sql?.engine ?? "duckdb",
        ...updates,
      },
    },
  };
}

export const CellMetadataBindingsLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const bindingService = yield* CellMetadataUIBindingService;
    const code = yield* VsCode;
    const datasources = yield* DatasourcesService;

    /**
     * SQL dataframeName binding
     * Allows editing the dataframe variable name that SQL query results are assigned to
     */
    yield* bindingService.registerBinding({
      id: "sql.dataframeName",
      type: "text",
      alignment: code.NotebookCellStatusBarAlignment.Left,

      shouldShow: (cell) => {
        return cell.document.languageId === LanguageId.Sql;
      },

      getValue: (metadata: CellMetadata) => {
        return metadata.languageMetadata?.sql?.dataframeName;
      },

      setValue: (metadata: CellMetadata, value: string | boolean) => {
        if (typeof value !== "string") {
          return metadata;
        }
        return updateSqlMetadata(metadata, { dataframeName: value });
      },

      getLabel: (value: string | boolean | undefined) => {
        const name = typeof value === "string" ? value : "unnamed";
        return `$(table) ${name}`;
      },

      getTooltip: (value: string | boolean | undefined) => {
        const name = typeof value === "string" ? value : "unnamed";
        return `SQL result dataframe: ${name} (click to edit)`;
      },

      inputPrompt: "Enter the variable name for the SQL query result",
      inputPlaceholder: "e.g., df, results, my_data",
      defaultValue: "df",

      validateInput: (value: string) => {
        // Python identifier validation
        if (!value) {
          return "Variable name cannot be empty";
        }
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
          return "Variable name must be a valid Python identifier (letters, numbers, underscores, must start with letter or underscore)";
        }
        // Reserved keywords check (basic list)
        const reservedKeywords = [
          "False",
          "None",
          "True",
          "and",
          "as",
          "assert",
          "async",
          "await",
          "break",
          "class",
          "continue",
          "def",
          "del",
          "elif",
          "else",
          "except",
          "finally",
          "for",
          "from",
          "global",
          "if",
          "import",
          "in",
          "is",
          "lambda",
          "nonlocal",
          "not",
          "or",
          "pass",
          "raise",
          "return",
          "try",
          "while",
          "with",
          "yield",
        ];
        if (reservedKeywords.includes(value)) {
          return `"${value}" is a Python reserved keyword`;
        }
        return undefined;
      },
    });

    /**
     * SQL showOutput binding
     * Toggle whether SQL query output is displayed
     */
    yield* bindingService.registerBinding({
      id: "sql.showOutput",
      type: "toggle",
      alignment: code.NotebookCellStatusBarAlignment.Left,

      shouldShow: (cell) => {
        return cell.document.languageId === LanguageId.Sql;
      },

      getValue: (metadata: CellMetadata) => {
        return metadata.languageMetadata?.sql?.showOutput ?? true;
      },

      setValue: (metadata: CellMetadata, value: string | boolean) => {
        if (typeof value !== "boolean") {
          return metadata;
        }
        return updateSqlMetadata(metadata, { showOutput: value });
      },

      getLabel: (value: string | boolean | undefined) => {
        const isVisible = value !== false;
        return isVisible ? "$(eye)" : "$(eye-closed)";
      },

      getTooltip: (value: string | boolean | undefined) => {
        const isVisible = value !== false;
        return isVisible
          ? "SQL output visible (click to hide)"
          : "SQL output hidden (click to show)";
      },
    });

    /**
     * SQL engine binding
     * Select the database connection/engine to use for SQL queries
     */
    yield* bindingService.registerBinding({
      id: "sql.engine",
      type: "option",
      alignment: code.NotebookCellStatusBarAlignment.Left,

      shouldShow: (cell) => {
        return cell.document.languageId === LanguageId.Sql;
      },

      getValue: (metadata: CellMetadata) => {
        return metadata.languageMetadata?.sql?.engine ?? "duckdb";
      },

      setValue: (metadata: CellMetadata, value: string | boolean) => {
        if (typeof value !== "string") {
          return metadata;
        }
        return updateSqlMetadata(metadata, { engine: value });
      },

      getLabel: (value: string | boolean | undefined) => {
        const engine = typeof value === "string" ? value : DEFAULT_ENGINE;
        if (engine === DEFAULT_ENGINE) {
          // Pretty name for default engine
          return DEFAULT_LABEL;
        }
        return `$(database) ${engine}`;
      },

      getTooltip: (value: string | boolean | undefined) => {
        const engine = typeof value === "string" ? value : DEFAULT_ENGINE;
        if (engine === DEFAULT_ENGINE) {
          // Pretty name for default engine
          return DEFAULT_LABEL;
        }
        return `SQL engine: ${engine} (click to change)`;
      },

      inputPlaceholder: "Select a database connection",

      getOptions: (cell) => {
        return Effect.gen(function* () {
          const NotebookUri = Brand.nominal<NotebookUri>();
          const notebookUri = NotebookUri(cell.notebook.uri.toString());
          const connectionsOption =
            yield* datasources.getConnections(notebookUri);

          // Always include duckdb as default
          const options: Array<{ label: string; value: string }> = [
            { label: DEFAULT_LABEL, value: DEFAULT_ENGINE },
          ];

          // Add available connections
          if (Option.isSome(connectionsOption)) {
            const connections = connectionsOption.value.connections;
            for (const [name, connection] of connections) {
              if (name === DEFAULT_ENGINE) {
                continue;
              }
              options.push({
                label: connection.display_name,
                value: name,
              });
            }
          }

          return options;
        });
      },
    });
  }),
);
