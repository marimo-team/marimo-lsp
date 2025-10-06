import {
  type Brand,
  Effect,
  Fiber,
  Option,
  type ParseResult,
  Runtime,
  Schema,
} from "effect";
import type * as vscode from "vscode";
import { NOTEBOOK_TYPE } from "../constants.ts";
import { MarimoNotebook } from "../schemas.ts";
import { isMarimoNotebookDocument } from "../utils/notebook.ts";
import { LanguageClient } from "./LanguageClient.ts";
import { VsCode } from "./VsCode.ts";

export type MarimoNotebookDocument = Brand.Branded<
  vscode.NotebookDocument,
  "MarimoNotebookDocument"
>;

/**
 * Handles serialization and deserialization of marimo notebooks,
 * converting between VS Code's notebook format and marimo's Python format.
 */
export class NotebookSerializer extends Effect.Service<NotebookSerializer>()(
  "NotebookSerializer",
  {
    scoped: Effect.gen(function* () {
      const client = yield* LanguageClient;
      const code = yield* Effect.serviceOption(VsCode);

      const serializeEffect = Effect.fnUntraced(function* (
        notebook: vscode.NotebookData,
      ) {
        yield* Effect.logDebug("Serializing notebook").pipe(
          Effect.annotateLogs({ cellCount: notebook.cells.length }),
        );

        const resp = yield* client.executeCommand({
          command: "marimo.serialize",
          params: {
            notebook: yield* notebookDataToMarimoNotebook(notebook),
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
          command: "marimo.deserialize",
          params: { source: new TextDecoder().decode(bytes) },
        });
        const { cells, ...metadata } = yield* decodeDeserializeResponse(resp);
        const notebook = {
          metadata: metadata,
          cells: cells.map((cell) => ({
            // Hard code to avoid taking dep on VsCode
            kind: 2 satisfies vscode.NotebookCellKind.Code,
            value: cell.code,
            languageId: "python",
            metadata: {
              name: cell.name,
              options: cell.options,
            },
          })),
        };
        yield* Effect.logDebug("Deserialization complete").pipe(
          Effect.annotateLogs({ cellCount: notebook.cells.length }),
        );
        return notebook;
      });

      if (Option.isSome(code)) {
        // Register with VS Code if present
        const runPromise = Runtime.runPromise(yield* Effect.runtime());

        yield* code.value.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, {
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
        });
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
): Effect.Effect<typeof MarimoNotebook.Type, ParseResult.ParseError, never> {
  const { cells, metadata = {} } = notebook;

  // Deserialize response is just the IR for our notebook
  return decodeDeserializeResponse({
    app: metadata.app ?? { options: {} },
    header: metadata.header ?? null,
    version: metadata.version ?? null,
    violations: metadata.violations ?? [],
    valid: metadata.valid ?? true,
    cells: cells.map((cell) => ({
      code:
        cell.kind === (1 satisfies vscode.NotebookCellKind.Markup)
          ? wrapInMarkdown(cell.value)
          : cell.value,
      name: cell.metadata?.name ?? DEFAULT_CELL_NAME,
      options: cell.metadata?.options ?? {},
    })),
  });
}

export function wrapInMarkdown(code: string): string {
  return `
mo.md(
r"""
${code}
""")`.trim();
}
