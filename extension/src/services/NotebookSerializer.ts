import { MarkdownParser, SQLParser } from "@marimo-team/smart-cells";
import {
  Effect,
  Fiber,
  Option,
  type ParseResult,
  Runtime,
  Schema,
} from "effect";
import type * as vscode from "vscode";
import { NOTEBOOK_TYPE } from "../constants.ts";
import {
  type CellMetadata,
  decodeCellMetadata,
  MarimoNotebook,
} from "../schemas.ts";
import { isMarimoNotebookDocument } from "../utils/notebook.ts";
import { Constants } from "./Constants.ts";
import { LanguageClient } from "./LanguageClient.ts";
import { VsCode } from "./VsCode.ts";

type BooleanMap<T> = {
  [key in keyof T]: boolean;
};

/**
 * Handles serialization and deserialization of marimo notebooks,
 * converting between VS Code's notebook format and marimo's Python format.
 */
export class NotebookSerializer extends Effect.Service<NotebookSerializer>()(
  "NotebookSerializer",
  {
    dependencies: [Constants.Default],
    scoped: Effect.gen(function* () {
      const client = yield* LanguageClient;
      const constants = yield* Constants;
      const code = yield* Effect.serviceOption(VsCode);

      const serializeEffect = Effect.fnUntraced(function* (
        notebook: vscode.NotebookData,
      ) {
        yield* Effect.logDebug("Serializing notebook").pipe(
          Effect.annotateLogs({ cellCount: notebook.cells.length }),
        );

        const resp = yield* client.executeCommand({
          command: "marimo.api",
          params: {
            method: "serialize",
            params: {
              notebook: yield* notebookDataToMarimoNotebook(
                notebook,
                constants,
              ),
            },
          },
        });
        const result = yield* decodeSerializeResponse(resp);
        const bytes = new TextEncoder().encode(result.source);
        yield* Effect.logDebug("Serialization complete").pipe(
          Effect.annotateLogs({ bytes: bytes.length }),
        );
        return bytes;
      });

      const deserializeEffect = Effect.fnUntraced(function* (
        bytes: Uint8Array,
      ) {
        yield* Effect.logDebug("Deserializing notebook").pipe(
          Effect.annotateLogs({ bytes: bytes.length }),
        );
        const resp = yield* client.executeCommand({
          command: "marimo.api",
          params: {
            method: "deserialize",
            params: { source: new TextDecoder().decode(bytes) },
          },
        });
        const { cells, ...metadata } = yield* decodeDeserializeResponse(resp);
        const sqlParser = new SQLParser();
        const markdownParser = new MarkdownParser();

        const notebook = {
          metadata: metadata,
          cells: cells.map((cell) => {
            const isNonEmpty = Boolean(cell.code.trim());

            // Check if this is a markdown cell (mo.md() without f-strings)
            if (isNonEmpty && markdownParser.isSupported(cell.code)) {
              const result = markdownParser.transformIn(cell.code);
              if (!result.metadata.quotePrefix.includes("f")) {
                return {
                  // Hard code to avoid taking dep on VsCode
                  kind: 1 satisfies vscode.NotebookCellKind.Markup,
                  value: result.code,
                  languageId: constants.LanguageId.Markdown,
                  metadata: {
                    name: cell.name,
                    options: cell.options,
                    languageMetadata: {
                      markdown: result.metadata,
                    },
                  } satisfies CellMetadata,
                };
              }
            }

            // Check if this is a SQL cell
            if (isNonEmpty && sqlParser.isSupported(cell.code)) {
              const result = sqlParser.transformIn(cell.code);
              return {
                // Hard code to avoid taking dep on VsCode
                kind: 2 satisfies vscode.NotebookCellKind.Code,
                value: result.code,
                languageId: constants.LanguageId.Sql,
                metadata: {
                  name: cell.name,
                  options: cell.options,
                  languageMetadata: {
                    sql: result.metadata,
                  },
                } satisfies CellMetadata,
              };
            }

            // Default Python cell
            return {
              // Hard code to avoid taking dep on VsCode
              kind: 2 satisfies vscode.NotebookCellKind.Code,
              value: cell.code,
              languageId: constants.LanguageId.Python,
              metadata: {
                name: cell.name,
                options: cell.options,
              } satisfies CellMetadata,
            };
          }),
        };
        yield* Effect.logDebug("Deserialization complete").pipe(
          Effect.annotateLogs({ cellCount: notebook.cells.length }),
        );
        return notebook;
      });

      if (Option.isSome(code)) {
        // Register with VS Code if present
        const runPromise = Runtime.runPromise(yield* Effect.runtime());

        yield* code.value.workspace.registerNotebookSerializer(
          NOTEBOOK_TYPE,
          {
            serializeNotebook(notebook, token) {
              return runPromise(
                Effect.gen(function* () {
                  const fiber = yield* Effect.fork(serializeEffect(notebook));
                  token.onCancellationRequested(() =>
                    runPromise(Fiber.interrupt(fiber)),
                  );
                  return yield* Fiber.join(fiber);
                }).pipe(
                  Effect.tapErrorCause((cause) =>
                    Effect.logError(`Notebook serialize failed.`, cause),
                  ),
                  Effect.mapError(
                    () =>
                      new Error(
                        `Failed to serialize notebook. See marimo logs for details.`,
                      ),
                  ),
                ),
              );
            },
            deserializeNotebook(bytes, token) {
              return runPromise(
                Effect.gen(function* () {
                  const fiber = yield* Effect.fork(deserializeEffect(bytes));
                  token.onCancellationRequested(() =>
                    runPromise(Fiber.interrupt(fiber)),
                  );
                  return yield* Fiber.join(fiber);
                }).pipe(
                  Effect.tapErrorCause((cause) =>
                    Effect.logError(`Notebook deserialize failed.`, cause),
                  ),
                  Effect.mapError(
                    () =>
                      new Error(
                        `Failed to deserialize notebook. See marimo logs for details.`,
                      ),
                  ),
                ),
              );
            },
          },
          {
            transientOutputs: true,
            transientCellMetadata: {
              state: true,
              name: false,
              languageMetadata: false,
              // N.B. This technically isn't transient (e.g. hide_code, disabled),
              // but as `false` it marks the cell as dirty.
              // But we don't support/use these options yet in the extension.
              options: true,
            } satisfies BooleanMap<CellMetadata>,
            transientDocumentMetadata: {
              app: false,
              header: false,
              version: false,
              cells: true,
              violations: false,
              valid: false,
            } satisfies BooleanMap<MarimoNotebook>,
          },
        );
      }

      return {
        notebookType: NOTEBOOK_TYPE,
        isMarimoNotebookDocument: isMarimoNotebookDocument,
        serializeEffect,
        deserializeEffect,
      };
    }),
  },
) {}

const decodeDeserializeResponse = Schema.decodeUnknown(MarimoNotebook);
const decodeSerializeResponse = Schema.decodeUnknown(
  Schema.Struct({ source: Schema.String }),
);

const DEFAULT_CELL_NAME = "_";

function notebookDataToMarimoNotebook(
  notebook: vscode.NotebookData,
  {
    LanguageId,
  }: {
    LanguageId: Constants["LanguageId"];
  },
): Effect.Effect<typeof MarimoNotebook.Type, ParseResult.ParseError, never> {
  const { cells, metadata = {} } = notebook;
  const sqlParser = new SQLParser();
  const markdownParser = new MarkdownParser();

  // Deserialize response is just the IR for our notebook
  return decodeDeserializeResponse({
    app: metadata.app ?? { options: {} },
    header: metadata.header ?? null,
    version: metadata.version ?? null,
    violations: metadata.violations ?? [],
    valid: metadata.valid ?? true,
    cells: cells.map((cell) => {
      const cellMeta = decodeCellMetadata(cell.metadata);

      // Handle markup cells
      if (cell.kind === (1 satisfies vscode.NotebookCellKind.Markup)) {
        // Check if this is a markdown cell with metadata
        if (cell.languageId === LanguageId.Markdown) {
          const result = markdownParser.transformOut(
            cell.value,
            cellMeta.pipe(
              Option.flatMap((x) =>
                Option.fromNullable(x.languageMetadata?.markdown),
              ),
              Option.getOrElse(() => markdownParser.defaultMetadata),
            ),
          );
          return {
            code: result.code,
            name: cell.metadata?.name ?? DEFAULT_CELL_NAME,
            options: cell.metadata?.options ?? {},
          };
        }
        // Otherwise use the default wrapInMarkdown
        return {
          code: wrapInMarkdown(cell.value),
          name: cell.metadata?.name ?? DEFAULT_CELL_NAME,
          options: cell.metadata?.options ?? {},
        };
      }

      // Handle SQL cells - transform back to Python mo.sql() wrapper
      if (cell.languageId === LanguageId.Sql) {
        const result = sqlParser.transformOut(
          cell.value,
          cellMeta.pipe(
            Option.flatMap((x) => Option.fromNullable(x.languageMetadata?.sql)),
            Option.getOrElse(() => sqlParser.defaultMetadata),
          ),
        );
        return {
          code: result.code,
          name: cell.metadata?.name ?? DEFAULT_CELL_NAME,
          options: cell.metadata?.options ?? {},
        };
      }

      // Default Python cells
      return {
        code: cell.value,
        name: cell.metadata?.name ?? DEFAULT_CELL_NAME,
        options: cell.metadata?.options ?? {},
      };
    }),
  });
}

export function wrapInMarkdown(code: string): string {
  return `
mo.md(r"""
${code}
""")`;
}
