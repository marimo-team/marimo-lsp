import * as vscode from "vscode";
import * as lsp from "vscode-languageclient/node";

import { MarimoNotebookSerializer } from "./notebookSerializer.ts";
import { kernelManager } from "./kernelManager.ts";
import { channel, Logger } from "./logging.ts";
import { registerCommand } from "./commands.ts";

export async function activate(context: vscode.ExtensionContext) {
  Logger.info("Extension", "Activating marimo-lsp extension", {
    extensionPath: context.extensionPath,
    workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  });

  const client = new lsp.LanguageClient(
    "marimo-lsp",
    "Marimo Language Server",
    {
      run: {
        command: "uv",
        args: ["run", "--offline", "marimo-lsp"],
        transport: lsp.TransportKind.stdio,
        options: {
          cwd: "/Users/manzt/demos/marimo-lsp",
        },
      },
      debug: {
        command: "uv",
        args: ["run", "--offline", "marimo-lsp"],
        transport: lsp.TransportKind.stdio,
        options: {
          cwd: "/Users/manzt/demos/marimo-lsp",
        },
      },
    },
    {
      outputChannel: channel,
      revealOutputChannelOn: lsp.RevealOutputChannelOn.Never,
      middleware: {
        notebooks: {
          didOpen(notebookDocument, cells, next) {
            Logger.debug(
              "Extension",
              "notebookDocument/didOpen",
              notebookDocument.uri.toString(),
            );
            return next(notebookDocument, cells);
          },
          didChange(event, next) {
            Logger.debug("Extension", "notebookDocument/didChange");
            Logger.debug(
              "Extension",
              "notebookDocument/didChange",
              event.notebook.uri.toString(),
            );
            return next(event);
          },
          didClose(notebookDocument, cells, next) {
            Logger.debug(
              "Extension",
              "notebookDocument/didClose",
              notebookDocument.uri.toString(),
            );
            return next(notebookDocument, cells);
          },
          didSave(notebookDocument, next) {
            Logger.debug(
              "Extension",
              "notebookDocument/didSave",
              notebookDocument.uri.toString(),
            );
            return next(notebookDocument);
          },
        },
        sendRequest(type, param, token, next) {
          const method = typeof type === "string" ? type : type.method;
          Logger.debug("LSP.sendRequest", method);
          Logger.trace("LSP.sendRequest", method, param);
          return next(type, param, token);
        },
        sendNotification(type, next, params) {
          const method = typeof type === "string" ? type : type.method;
          if (!method.startsWith("notebookDocument/")) {
            Logger.debug("LSP.sendNotification", method);
            Logger.trace("LSP.sendNotification", method, params);
          }
          return next(type, params);
        },
      },
    },
  );

  const controller = new AbortController();
  kernelManager(client, { signal: controller.signal });

  context.subscriptions.push(
    {
      dispose: () => controller.abort(),
    },
    client,
    vscode.workspace.registerNotebookSerializer(
      MarimoNotebookSerializer.notebookType,
      new MarimoNotebookSerializer(client),
    ),
    registerCommand("marimo-lsp.newMarimoNotebook", async () => {
      const doc = await vscode.workspace.openNotebookDocument(
        MarimoNotebookSerializer.notebookType,
        new vscode.NotebookData([
          new vscode.NotebookCellData(
            vscode.NotebookCellKind.Code,
            "",
            "python",
          ),
        ]),
      );
      await vscode.window.showNotebookDocument(doc);
      Logger.info("Extension", "Created new marimo notebook");
    }),
  );

  await client.start().then(() => {
    Logger.info("Extension", "LSP client started");

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
  }).catch((error) => {
    Logger.error("Extension", "Failed to start LSP client", error);
    vscode.window.showErrorMessage(
      `Marimo language server failed to start ${JSON.stringify(error.message)}`,
    );
  });
  Logger.info("Extension", "Marimo extension activation complete");
}

export async function deactivate() {
  Logger.info("Extension", "Deactivating marimo extension");
  Logger.close();
}
