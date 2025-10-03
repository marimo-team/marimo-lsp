import { type Brand, Effect, FiberSet } from "effect";
import type * as vscode from "vscode";
import { NOTEBOOK_TYPE } from "../constants.ts";
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
    dependencies: [VsCode.Default, LanguageClient.Default],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const marimo = yield* LanguageClient;
      const runPromise = yield* FiberSet.makeRuntimePromise();

      yield* Effect.logInfo("Setting up notebook serializer");

      yield* code.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, {
        serializeNotebook(notebook) {
          return runPromise(
            Effect.gen(function* () {
              yield* Effect.logDebug("Serializing notebook").pipe(
                Effect.annotateLogs({ cellCount: notebook.cells.length }),
              );
              const bytes = yield* marimo.serialize(notebook);
              yield* Effect.logDebug("Serialization complete").pipe(
                Effect.annotateLogs({ bytes: bytes.length }),
              );
              return bytes;
            }).pipe(
              Effect.tapError((error) =>
                Effect.logError(`Notebook serialize failed.`, error),
              ),
              Effect.mapError(
                () =>
                  new Error(
                    `Failed to serialize notebook. See marimo logs for details.`,
                  ),
              ),
              Effect.annotateLogs("service", "NotebookSerializer"),
            ),
          );
        },
        deserializeNotebook(bytes) {
          return runPromise(
            Effect.gen(function* () {
              yield* Effect.logDebug("Deserializing notebook").pipe(
                Effect.annotateLogs({ bytes: bytes.length }),
              );
              const notebook = yield* marimo.deserialize(bytes);
              yield* Effect.logDebug("Deserialization complete").pipe(
                Effect.annotateLogs({ cellCount: notebook.cells.length }),
              );
              return notebook;
            }).pipe(
              Effect.tapError((error) =>
                Effect.logError(`Notebook deserialize failed.`, error),
              ),
              Effect.mapError(
                () =>
                  new Error(
                    `Failed to deserialize notebook. See marimo logs for details.`,
                  ),
              ),
              Effect.annotateLogs("service", "NotebookSerializer"),
            ),
          );
        },
      });

      return {
        notebookType: NOTEBOOK_TYPE,
        isMarimoNotebookDocument(
          notebook: vscode.NotebookDocument,
        ): notebook is MarimoNotebookDocument {
          return notebook.notebookType === NOTEBOOK_TYPE;
        },
      };
    }),
  },
) {}
