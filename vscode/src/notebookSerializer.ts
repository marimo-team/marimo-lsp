import * as vscode from "vscode";
import * as lsp from "vscode-languageclient";
import { Data, Effect, ParseResult, Schema } from "effect";

import { NotebookSerializationSchema } from "./schemas.ts";
import { Logger } from "./logging.ts";
import * as cmds from "./commands.ts";

class ExecuteCommandError extends Data.TaggedError("ExecuteCommandError")<{
  source: unknown;
}> {}

export class MarimoNotebookSerializer implements vscode.NotebookSerializer {
  static readonly notebookType = "marimo-lsp-notebook";
  private client: lsp.BaseLanguageClient;

  constructor(client: lsp.BaseLanguageClient) {
    this.client = client;
  }

  async serializeNotebook(
    notebook: vscode.NotebookData,
    token: vscode.CancellationToken,
  ): Promise<Uint8Array> {
    Logger.debug("MarimoNotebookSerializer", "serializeNotebook");
    Logger.trace("MarimoNotebookSerializer", "serializeNotebook", notebook);

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
            "MarimoNotebookSerializer",
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
            "MarimoNotebookSerializer",
            "marimo.serialize failed",
            error,
          );
          return Effect.void;
        }),
      );

      return new TextEncoder().encode(source);
    });

    return Effect.runPromise(program);
  }

  async deserializeNotebook(
    data: Uint8Array,
    token: vscode.CancellationToken,
  ): Promise<vscode.NotebookData> {
    const source = new TextDecoder().decode(data);
    Logger.debug("MarimoNotebookSerializer", "deserializeNotebook");
    Logger.trace("MarimoNotebookSerializer", "deserializeNotebook", source);

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
        Effect.andThen(
          Schema.decodeUnknown(NotebookSerializationSchema),
        ),
        Effect.tapError((error) => {
          Logger.error(
            "MarimoNotebookSerializer",
            "marimo.deserialize failed",
            error,
          );
          return Effect.void;
        }),
      );
      const { cells, ...metadata } = notebookData;
      return {
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
    });

    return Effect.runPromise(program);
  }
}
