import { Data, Effect, ParseResult, Schema } from "effect";
import * as vscode from "vscode";
import type * as lsp from "vscode-languageclient";
import * as cmds from "./commands.ts";
import { Logger } from "./logging.ts";
import { NotebookSerializationSchema } from "./schemas.ts";
import { notebookType } from "./types.ts";

class ExecuteCommandError extends Data.TaggedError("ExecuteCommandError")<{
  source: unknown;
}> {}

export function notebookSerializer(
  client: lsp.BaseLanguageClient,
  options: { signal: AbortSignal },
) {
  const disposer = vscode.workspace.registerNotebookSerializer(
    notebookType,
    new MarimoNotebookSerializer(client),
  );
  options.signal.addEventListener("aborted", () => {
    disposer.dispose();
  });
}

export class MarimoNotebookSerializer implements vscode.NotebookSerializer {
  private client: lsp.BaseLanguageClient;

  constructor(client: lsp.BaseLanguageClient) {
    this.client = client;
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

    const client = this.client;
    const { cells, metadata = {} } = notebook;

    const program = Effect.gen(function* () {
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

      const { source } = yield* Effect.tryPromise({
        try: () =>
          cmds.executeCommand(client, {
            command: "marimo.serialize",
            params: { notebook: notebookData },
            token: token,
          }),
        catch: (error) => new ExecuteCommandError({ source: error }),
      }).pipe(
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

    return Effect.runPromise(program);
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

    const client = this.client;

    const program = Effect.gen(function* () {
      const notebookData = yield* Effect.tryPromise({
        try: () =>
          cmds.executeCommand(client, {
            command: "marimo.deserialize",
            params: { source },
            token,
          }),
        catch: (error) => new ExecuteCommandError({ source: error }),
      }).pipe(
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

    return Effect.runPromise(program);
  }
}
