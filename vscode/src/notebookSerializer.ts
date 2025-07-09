import * as vscode from "vscode";
import * as lsp from "vscode-languageclient";
import * as z from "zod/v4";

import { NotebookSerialization } from "./schemas.ts";
import { Logger } from "./logging.ts";
import * as commands from "./commands.ts";

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

    const { cells, metadata = {} } = notebook;
    const result = NotebookSerialization.safeParse({
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
    });

    if (!result.success) {
      Logger.error(
        "MarimoNotebookSerializer",
        "Failed to parse notebook data",
        {
          error: z.prettifyError(result.error),
          metadata,
        },
      );
      throw new Error(z.prettifyError(result.error));
    }

    try {
      const response = await commands.executeCommand(this.client, {
        command: "marimo.serialize",
        params: { notebook: result.data },
        token: token,
      }).then((raw) => z.object({ source: z.string() }).parse(raw));

      return new TextEncoder().encode(response.source);
    } catch (error) {
      Logger.error("NotebookSerializer", "Failed to serialize notebook", error);
      throw error;
    }
  }

  async deserializeNotebook(
    data: Uint8Array,
    token: vscode.CancellationToken,
  ): Promise<vscode.NotebookData> {
    const source = new TextDecoder().decode(data);
    Logger.debug("MarimoNotebookSerializer", "deserializeNotebook");
    Logger.trace("MarimoNotebookSerializer", "deserializeNotebook", source);

    try {
      const notebookData = await commands.executeCommand(this.client, {
        command: "marimo.deserialize",
        params: { source },
        token,
      }).then((raw) => NotebookSerialization.parse(raw));

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
    } catch (error) {
      Logger.error(
        "MarimoNotebookSerializer",
        "Failed to deserialize notebook",
        error,
      );
      throw error;
    }
  }
}
