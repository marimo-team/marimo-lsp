import { Effect, type Layer, ParseResult, Schema } from "effect";
import * as vscode from "vscode";
import { Logger } from "./logging.ts";
import { NotebookSerializationSchema } from "./schemas.ts";
import { MarimoLanguageClient } from "./services.ts";
import { notebookType } from "./types.ts";

export function notebookSerializer(
  layer: Layer.Layer<MarimoLanguageClient>,
  options: { signal: AbortSignal },
) {
  const disposer = vscode.workspace.registerNotebookSerializer(
    notebookType,
    new MarimoNotebookSerializer(layer),
  );
  options.signal.addEventListener("aborted", () => {
    disposer.dispose();
  });
}

export class MarimoNotebookSerializer implements vscode.NotebookSerializer {
  private layer: Layer.Layer<MarimoLanguageClient>;

  constructor(layer: Layer.Layer<MarimoLanguageClient>) {
    this.layer = layer;
  }

  async serializeNotebook(
    notebook: vscode.NotebookData,
    token: vscode.CancellationToken,
  ): Promise<Uint8Array> {
    const startTime = Date.now();
    Logger.debug("Serializer", "Serializing notebook", {
      cellCount: notebook.cells.length,
    });
    Logger.trace("Serializer.Data", "Notebook data", notebook);
    const { cells, metadata = {} } = notebook;

    const program = Effect.gen(function* () {
      const client = yield* MarimoLanguageClient;
      const notebookData = yield* Schema.decodeUnknown(
        NotebookSerializationSchema,
      )({
        app: metadata.app ?? { options: {} },
        header: metadata.header ?? null,
        version: metadata.version ?? null,
        violations: metadata.violations ?? [],
        valid: metadata.valid ?? true,
        cells: cells.map((cell) => ({
          code: cell.value,
          name: cell.metadata?.name ?? "_",
          options: cell.metadata?.options ?? {},
        })),
      }).pipe(
        Effect.tapErrorTag("ParseError", (error) => {
          Logger.error(
            "Serializer.Parse",
            "Failed to parse notebook data",
            ParseResult.TreeFormatter.formatErrorSync(error),
          );
          return Effect.void;
        }),
      );

      const { source } = yield* client
        .serialize({ notebook: notebookData })
        .pipe(
          Effect.andThen(
            Schema.decodeUnknown(Schema.Struct({ source: Schema.String })),
          ),
          Effect.tapError((error) => {
            Logger.error(
              "Serializer.Command",
              "marimo.serialize command failed",
              error,
            );
            return Effect.void;
          }),
        );

      const result = new TextEncoder().encode(source);
      Logger.debug("Serializer", "Serialization complete", {
        duration: Date.now() - startTime,
        bytes: result.length,
      });
      return result;
    });

    return this.runProgram(program, token);
  }

  async deserializeNotebook(
    data: Uint8Array,
    token: vscode.CancellationToken,
  ): Promise<vscode.NotebookData> {
    const source = new TextDecoder().decode(data);
    const startTime = Date.now();
    Logger.debug("Serializer", "Deserializing notebook", {
      bytes: data.length,
    });
    Logger.trace("Serializer.Data", "Source content", source);

    const program = Effect.gen(function* () {
      const client = yield* MarimoLanguageClient;
      const notebookData = yield* client.deserialize({ source }).pipe(
        Effect.andThen(Schema.decodeUnknown(NotebookSerializationSchema)),
        Effect.tapError((error) => {
          Logger.error(
            "Serializer.Command",
            "marimo.deserialize command failed",
            error,
          );
          return Effect.void;
        }),
      );
      const { cells, ...metadata } = notebookData;
      const result = {
        metadata: metadata,
        cells: cells.map((cell) => ({
          kind: vscode.NotebookCellKind.Code,
          value: cell.code,
          languageId: "python",
          metadata: {
            name: cell.name,
            options: cell.options,
          },
        })),
      };
      Logger.debug("Serializer", "Deserialization complete", {
        duration: Date.now() - startTime,
        cellCount: result.cells.length,
      });
      return result;
    });

    const result = this.runProgram(program, token);
    return result;
  }

  private runProgram<T, E>(
    program: Effect.Effect<T, E, MarimoLanguageClient>,
    token: vscode.CancellationToken,
  ): Promise<T> {
    const controller = new AbortController();
    token.onCancellationRequested(() => {
      controller.abort();
    });
    const runnable = Effect.provide(program, this.layer);
    return Effect.runPromise(runnable, { signal: controller.signal });
  }
}
