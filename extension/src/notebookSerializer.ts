import { Effect, type Layer } from "effect";
import * as vscode from "vscode";
import { MarimoLanguageClient, runPromise } from "./services.ts";
import { notebookType } from "./types.ts";

export function notebookSerializer(
  layer: Layer.Layer<MarimoLanguageClient>,
  options: { signal: AbortSignal },
) {
  const disposer = vscode.workspace.registerNotebookSerializer(notebookType, {
    async serializeNotebook(
      notebook: vscode.NotebookData,
      token: vscode.CancellationToken,
    ): Promise<Uint8Array> {
      return run(
        Effect.gen(function* () {
          const client = yield* MarimoLanguageClient;
          yield* Effect.logDebug("Serializing notebook").pipe(
            Effect.annotateLogs({ cellCount: notebook.cells.length }),
          );
          const bytes = yield* client.serialize(notebook);
          yield* Effect.logDebug("Serialization complete").pipe(
            Effect.annotateLogs({ bytes: bytes.length }),
          );
          return bytes;
        }),
        {
          layer,
          token,
          kind: "serialization",
        },
      );
    },
    async deserializeNotebook(
      bytes: Uint8Array,
      token: vscode.CancellationToken,
    ): Promise<vscode.NotebookData> {
      return run(
        Effect.gen(function* () {
          const client = yield* MarimoLanguageClient;
          yield* Effect.logDebug("Deserializing notebook").pipe(
            Effect.annotateLogs({ bytes: bytes.length }),
          );
          const notebook = yield* client.deserialize(bytes);
          yield* Effect.logDebug("Deserialization complete").pipe(
            Effect.annotateLogs({ cellCount: notebook.cells.length }),
          );
          return notebook;
        }),
        {
          kind: "deserialization",
          layer,
          token,
        },
      );
    },
  });
  options.signal.addEventListener("aborted", () => {
    disposer.dispose();
  });
}

function run<T, E>(
  program: Effect.Effect<T, E, MarimoLanguageClient>,
  options: {
    layer: Layer.Layer<MarimoLanguageClient>;
    token: vscode.CancellationToken;
    kind: "deserialization" | "serialization";
  },
): Promise<T> {
  const { token, kind, layer } = options;
  const controller = new AbortController();
  token.onCancellationRequested(() => {
    controller.abort();
  });
  const runnable = program.pipe(
    Effect.tapError((error) =>
      Effect.logError(`Notebook ${kind} failed.`, error),
    ),
    Effect.mapError(
      // show logs
      () => new Error(`Notebook ${kind} failed. See logs for details.`),
    ),
    Effect.provide(layer),
  );
  return runPromise(runnable, { signal: controller.signal });
}
