import { Effect, FiberSet } from "effect";
import { LanguageClient } from "./LanguageClient.ts";
import { VsCode } from "./VsCode.ts";

/**
 * Handles serialization and deserialization of marimo notebooks,
 * converting between VS Code's notebook format and marimo's Python format.
 */
export class NotebookSerializer extends Effect.Service<NotebookSerializer>()(
  "NotebookSerializer",
  {
    dependencies: [VsCode.Default, LanguageClient.Default],
    scoped: Effect.gen(function* () {
      const notebookType = "marimo-notebook";

      const code = yield* VsCode;
      const marimo = yield* LanguageClient;
      const runPromise = yield* FiberSet.makeRuntimePromise();

      yield* Effect.logInfo("Setting up notebook serializer").pipe(
        Effect.annotateLogs({ component: "notebook-serializer" }),
      );

      yield* code.workspace.registerNotebookSerializer(notebookType, {
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
                  new Error(`Notebook serialize failed. See logs for details.`),
              ),
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
                    `Notebook deserialize failed. See logs for details.`,
                  ),
              ),
            ),
          );
        },
      });

      return { notebookType };
    }),
  },
) {}
