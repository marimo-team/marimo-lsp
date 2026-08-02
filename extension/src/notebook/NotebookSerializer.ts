import { MarkdownParser, SQLParser } from "@marimo-team/smart-cells";
import {
  Cause,
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
import { MarimoClient } from "../lsp/MarimoClient.ts";
import { Constants } from "../platform/Constants.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../schemas/MarimoNotebookDocument.ts";
import * as Api from "../schemas/Models.gen.ts";
import { classifyCellCode } from "./classifyCellCode.ts";
import { pickLiveNotebook } from "./pickLiveNotebook.ts";

type BooleanMap<T> = {
  [key in keyof T]: boolean;
};

type EncodedCellMetadata = typeof Api.CellMetadata.Encoded;
type EncodedNotebookDocumentMetadata =
  typeof Api.NotebookDocumentMetadata.Encoded;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

const parseNotebookDocumentMetadata = (value: unknown) => {
  const root = asRecord(value);
  return Schema.decodeUnknown(Api.MarimoNotebookMetadata)(root.marimo ?? {});
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
      const marimo = yield* MarimoClient;
      const constants = yield* Constants;
      const code = yield* Effect.serviceOption(VsCode);

      const serializeEffect = Effect.fn("NotebookSerializer.serialize")(
        function* (notebook: vscode.NotebookData) {
          yield* Effect.annotateCurrentSpan("cellCount", notebook.cells.length);

          const result = yield* marimo.serialize(
            yield* notebookDataToNotebookDocument(notebook, constants),
          );
          return new TextEncoder().encode(result.source);
        },
      );

      const deserializeEffect = Effect.fn("NotebookSerializer.deserialize")(
        function* (bytes: Uint8Array) {
          yield* Effect.annotateCurrentSpan("bytes", bytes.length);
          const {
            notebook: document,
            appConfig,
            header,
          } = yield* marimo.deserialize({
            source: new TextDecoder().decode(bytes),
          });

          const notebook = {
            metadata: MarimoNotebookDocument.createMetadata({
              appConfig,
              header,
              notebookMetadata: document.metadata,
            }),
            cells: document.cells.map((cell) => {
              // Same classification the live transaction path uses, so a file
              // open and a code-mode commit agree on markdown/sql vs python.
              const classified = classifyCellCode(
                cell.code ?? "",
                constants.LanguageId,
              );
              return {
                kind: classified.kind,
                value: classified.code,
                languageId: classified.languageId,
                metadata: MarimoNotebookCell.createMetadata({
                  marimo: {
                    name: cell.name ?? DEFAULT_CELL_NAME,
                    options: cell.config,
                    ...(classified.sourceProjections
                      ? { sourceProjections: classified.sourceProjections }
                      : {}),
                  },
                  marimoRuntime: {
                    stableId: cell.id ?? crypto.randomUUID(),
                  },
                }),
              };
            }),
          };

          yield* Effect.annotateCurrentSpan("cellCount", notebook.cells.length);

          if (Option.isNone(code)) return notebook;

          const liveDoc = yield* pickLiveNotebook(bytes, code.value);
          if (Option.isNone(liveDoc)) return notebook;

          return enrichNotebookFromLive(
            notebook,
            snapshotLiveNotebook(liveDoc.value, code.value),
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
                      Effect.annotateLogs({
                        cause,
                        "error.tag": causeTag(cause),
                      }),
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
                      Effect.annotateLogs({
                        cause,
                        "error.tag": causeTag(cause),
                      }),
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
              marimo: false,
              // Runtime metadata is ephemeral and never written to the .py
              // file. Marking the whole namespace transient keeps stable-ID
              // and execution-state changes from dirtying the document.
              marimoRuntime: true,
            } satisfies BooleanMap<EncodedCellMetadata>,
            transientDocumentMetadata: {
              marimo: false,
            } satisfies BooleanMap<EncodedNotebookDocumentMetadata>,
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

function hasStringTag(value: unknown): value is { _tag: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    typeof value._tag === "string"
  );
}

function causeTag(cause: Cause.Cause<unknown>): string {
  return Option.match(Cause.failureOption(cause), {
    onSome: (failure) => (hasStringTag(failure) ? failure._tag : "Unknown"),
    onNone: () => {
      if (Cause.isDie(cause)) return "Die";
      if (Cause.isInterruptedOnly(cause)) return "Interrupt";
      return "Empty";
    },
  });
}

const DEFAULT_CELL_NAME = "_";

function notebookDataToNotebookDocument(
  notebook: vscode.NotebookData,
  {
    LanguageId,
  }: {
    LanguageId: Constants["LanguageId"];
  },
): Effect.Effect<typeof Api.SerializePayload.Encoded, ParseResult.ParseError> {
  const { cells, metadata = {} } = notebook;
  const sqlParser = new SQLParser();
  const markdownParser = new MarkdownParser();
  return Effect.gen(function* () {
    const documentMetadata = yield* parseNotebookDocumentMetadata(metadata);
    const decodedCells = yield* Effect.forEach(cells, (cell) => {
      const hasMarimoMetadata = asRecord(cell.metadata).marimo !== undefined;
      return Schema.decodeUnknown(Api.CellMetadata)(cell.metadata ?? {}).pipe(
        Effect.map((cellMetadata) => ({
          cell,
          cellMetadata,
          hasMarimoMetadata,
        })),
      );
    });

    return {
      notebook: {
        version: "1",
        metadata: documentMetadata.notebookMetadata ?? {},
        cells: decodedCells.map(({ cell, cellMetadata, hasMarimoMetadata }) => {
          const name = cellMetadata.marimo.name;
          const config = (fallback: typeof Api.NotebookCellConfig.Type) =>
            hasMarimoMetadata ? cellMetadata.marimo.options : fallback;

          // oxlint-disable-next-line typescript/no-unsafe-enum-comparison
          if (cell.kind === NotebookCellKind.Markup) {
            // Check if this is a markdown cell with metadata
            if (cell.languageId === LanguageId.Markdown) {
              const result = markdownParser.transformOut(
                cell.value,
                cellMetadata.marimo.sourceProjections.markdown ??
                  markdownParser.defaultMetadata,
              );
              return {
                id: null,
                code: result.code,
                code_hash: null,
                name,
                config: config({ hide_code: true }),
              };
            }
            // Otherwise use the default wrapInMarkdown
            return {
              id: null,
              code: wrapInMarkdown(cell.value),
              code_hash: null,
              name,
              config: config({ hide_code: true }),
            };
          }

          // Handle SQL cells - transform back to Python mo.sql() wrapper
          if (cell.languageId === LanguageId.Sql) {
            const result = sqlParser.transformOut(
              cell.value,
              cellMetadata.marimo.sourceProjections.sql ??
                sqlParser.defaultMetadata,
            );
            return {
              id: null,
              code: result.code,
              code_hash: null,
              name,
              config: config({}),
            };
          }

          // Default Python cells
          return {
            id: null,
            code: cell.value,
            code_hash: null,
            name,
            config: config({}),
          };
        }),
      },
      appConfig: documentMetadata.appConfig,
      header: documentMetadata.header ?? null,
    };
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
 * that `enrichNotebookFromLive` expects.
 *
 * Outputs are reconstructed as *fresh* `NotebookCellOutput` /
 * `NotebookCellOutputItem` instances, not spread references to the live
 * cell's outputs. VS Code's notebook model treats same-identity output
 * objects as "unchanged" and skips rendering them when they flow back
 * through `deserializeNotebook`; constructing new instances forces the
 * renderer to re-pick up the data. Matches what the built-in ipynb
 * serializer does in vscode/extensions/ipynb/src/deserializers.ts.
 */
function snapshotLiveNotebook(
  doc: vscode.NotebookDocument,
  code: VsCode,
): vscode.NotebookData {
  return {
    metadata: doc.metadata,
    cells: doc.getCells().map((cell) => ({
      kind: cell.kind,
      value: cell.document.getText(),
      languageId: cell.document.languageId,
      outputs: cell.outputs.map(
        (out) =>
          new code.NotebookCellOutput(
            out.items.map(
              (item) => new code.NotebookCellOutputItem(item.data, item.mime),
            ),
            out.metadata,
          ),
      ),
      metadata: cell.metadata,
    })),
  };
}
