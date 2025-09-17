import { Layer } from "effect";
import * as vscode from "vscode";
import * as lsp from "vscode-languageclient/node";

import * as cmds from "./commands.ts";
import { debugAdapter } from "./debugAdapter.ts";
import { kernelManager } from "./kernelManager.ts";
import { languageClient } from "./languageClient.ts";
import { Logger } from "./logging.ts";
import { notebookSerializer } from "./notebookSerializer.ts";
import {
  LoggerLive,
  MarimoLanguageClient,
  RawLanguageClient,
} from "./services.ts";
import { notebookType } from "./types.ts";

export async function activate(context: vscode.ExtensionContext) {
  Logger.info("Extension.Lifecycle", "Activating marimo", {
    extensionPath: context.extensionPath,
    workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  });

  const controller = new AbortController();
  const signal = controller.signal;

  const client = languageClient({ signal });

  const MainLive = Layer.provideMerge(
    LoggerLive,
    Layer.provide(
      MarimoLanguageClient.Default,
      RawLanguageClient.layer(client),
    ),
  );

  debugAdapter(client, { signal });

  kernelManager(MainLive, { signal }).catch((error) => {
    Logger.error(
      "Extension.Lifecycle",
      "Failed to start kernel manager",
      error,
    );
    vscode.window.showErrorMessage(
      `Marimo kernel manager failed to start: ${error.message || JSON.stringify(error)}`,
    );
  });

  notebookSerializer(MainLive, { signal });

  context.subscriptions.push(
    { dispose: () => controller.abort() },
    cmds.registerCommand("marimo.newMarimoNotebook", async () => {
      const doc = await vscode.workspace.openNotebookDocument(
        notebookType,
        new vscode.NotebookData([
          new vscode.NotebookCellData(
            vscode.NotebookCellKind.Code,
            "",
            "python",
          ),
        ]),
      );
      await vscode.window.showNotebookDocument(doc);
      Logger.info("Command", "Created new marimo notebook", {
        uri: doc.uri.toString(),
      });
    }),
  );

  await client
    .start()
    .then(() => {
      Logger.info("Extension.Lifecycle", "LSP client started successfully");
      // Forward logs from the LSP server
      client.onNotification(
        "window/logMessage",
        ({ type, message }: lsp.LogMessageParams) => {
          const mapping = {
            [lsp.MessageType.Error]: "error",
            [lsp.MessageType.Warning]: "warn",
            [lsp.MessageType.Info]: "info",
            [lsp.MessageType.Log]: "info",
            [lsp.MessageType.Debug]: "debug",
          } as const;
          Logger[mapping[type]]("LSP.Server", message);
        },
      );
    })
    .catch((error) => {
      Logger.error("Extension.Lifecycle", "Failed to start LSP client", error);
      vscode.window.showErrorMessage(
        `Marimo language server failed to start ${JSON.stringify(error.message)}`,
      );
    });
  Logger.info("Extension.Lifecycle", "Activation complete");
}

export async function deactivate() {
  Logger.info("Extension.Lifecycle", "Deactivating marimo");
  Logger.close();
}
