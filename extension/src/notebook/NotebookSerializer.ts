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
import { enrichNotebookFromLive } from "../lib/enrichNotebookFromLive.ts";
import { LanguageClient } from "../lsp/LanguageClient.ts";
import { Constants } from "../platform/Constants.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  type CellMetadata,
  decodeCellMetadata,
} from "../schemas/CellMetadata.ts";
import { SerializedNotebook } from "../schemas/SerializedNotebook.ts";
import { pickLiveNotebook } from "./pickLiveNotebook.ts";

type BooleanMap<T> = {
  [key in keyof T]: boolean;
};

const NotebookCellKind = {
  Markup: 1,
  Code: 2,
} as const satisfies typeof vscode.NotebookCellKind;

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

      const serializeEffect = Effect.fn("NotebookSerializer.serialize")(
        function* (notebook: vscode.NotebookData) {
          yield* Effect.annotateCurrentSpan("cellCount", notebook.cells.length);

          const resp = yield* client.executeCommand({
            command: "marimo.api",
            params: {
              method: "serialize",
              params: {
                notebook: yield* notebookDataToSerializedNotebook(
                  notebook,
                  constants,
                ),
              },
            },
          });
          const result = yield* decodeSerializeResponse(resp);
          return new TextEncoder().encode(result.source);
        },
      );

      const deserializeEffect = Effect.fn("NotebookSerializer.deserialize")(
        function* (bytes: Uint8Array) {
          yield* Effect.annotateCurrentSpan("bytes", bytes.length);
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
                    kind: NotebookCellKind.Markup,
                    value: result.code,
                    languageId: constants.LanguageId.Markdown,
                    metadata: {
                      name: cell.name,
                      options: cell.options,
                      languageMetadata: {
                        markdown: result.metadata,
                      },
                      stableId: crypto.randomUUID(),
                    } satisfies CellMetadata,
                  };
                }
              }

              // Check if this is a SQL cell
              if (isNonEmpty && sqlParser.isSupported(cell.code)) {
                const result = sqlParser.transformIn(cell.code);
                return {
                  kind: NotebookCellKind.Code,
                  value: result.code,
                  languageId: constants.LanguageId.Sql,
                  metadata: {
                    name: cell.name,
                    options: cell.options,
                    languageMetadata: {
                      sql: result.metadata,
                    },
                    stableId: crypto.randomUUID(),
                  } satisfies CellMetadata,
                };
              }

              // Default Python cell
              return {
                kind: NotebookCellKind.Code,
                value: cell.code,
                languageId: constants.LanguageId.Python,
                metadata: {
                  name: cell.name,
                  options: cell.options,
                  stableId: crypto.randomUUID(),
                } satisfies CellMetadata,
              };
            }),
          };

          yield* Effect.annotateCurrentSpan("cellCount", notebook.cells.length);

          if (Option.isNone(code)) return notebook;

          const liveDoc = yield* pickLiveNotebook(bytes, code.value);
          if (Option.isNone(liveDoc)) return notebook;

          return enrichNotebookFromLive(
            notebook,
            snapshotLiveNotebook(liveDoc.value),
          );
        },
      );

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
                    Effect.logError(`Notebook serialize failed`).pipe(
                      Effect.annotateLogs({ cause }),
                    ),
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
                    Effect.logError(`Notebook deserialize failed`).pipe(
                      Effect.annotateLogs({ cause }),
                    ),
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
            // Outputs are not persisted to the .py file — they're ephemeral
            // and restored at deserialize time from the matched live
            // NotebookDocument (see pickLiveNotebook + enrichNotebookFromLive).
            // Marking as transient prevents cell execution from dirtying the
            // notebook, which would block auto-reload of external file changes.
            transientOutputs: true,
            transientCellMetadata: {
              state: true,
              name: false,
              languageMetadata: false,
              // Stable ID is ephemeral — regenerated on every deserialize
              // and never written to the .py file. Transient so VS Code
              // strips it from the serialize payload (we don't use it
              // there anyway) and changes don't dirty the doc. External
              // reloads restore it from the live doc via
              // enrichNotebookFromLive.
              stableId: true,
              options: false,
            } satisfies BooleanMap<CellMetadata>,
            transientDocumentMetadata: {
              app: false,
              header: false,
              version: false,
              cells: true,
              // Violations and valid are computed during deserialization
              // and don't affect the serialized .py output.
              violations: true,
              valid: true,
            } satisfies BooleanMap<SerializedNotebook>,
          },
        );
      }

      return {
        notebookType: NOTEBOOK_TYPE,
        serializeEffect,
        deserializeEffect,
      };
    }),
  },
) {}

const decodeDeserializeResponse = Schema.decodeUnknown(SerializedNotebook);
const decodeSerializeResponse = Schema.decodeUnknown(
  Schema.Struct({ source: Schema.String }),
);

const DEFAULT_CELL_NAME = "_";

function notebookDataToSerializedNotebook(
  notebook: vscode.NotebookData,
  {
    LanguageId,
  }: {
    LanguageId: Constants["LanguageId"];
  },
): Effect.Effect<typeof SerializedNotebook.Type, ParseResult.ParseError> {
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

      // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
      if (cell.kind === NotebookCellKind.Markup) {
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
            options: cell.metadata?.options ?? { hide_code: true },
          };
        }
        // Otherwise use the default wrapInMarkdown
        return {
          code: wrapInMarkdown(cell.value),
          name: cell.metadata?.name ?? DEFAULT_CELL_NAME,
          options: cell.metadata?.options ?? { hide_code: true },
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

/**
 * Snapshot a live `NotebookDocument`'s cells into the `NotebookData` shape
 * that `enrichNotebookFromLive` expects. Copies outputs and metadata by
 * reference — the snapshot is read-only and short-lived.
 */
function snapshotLiveNotebook(
  doc: vscode.NotebookDocument,
): vscode.NotebookData {
  return {
    metadata: doc.metadata,
    cells: doc.getCells().map((cell) => ({
      kind: cell.kind,
      value: cell.document.getText(),
      languageId: cell.document.languageId,
      outputs: [...cell.outputs],
      metadata: cell.metadata,
    })),
  };
}
