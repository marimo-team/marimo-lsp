import * as vscode from "vscode";
import * as lsp from "vscode-languageclient/node";

import { MarimoNotebookSerializer } from "./notebookSerializer.ts";
import { kernelManager } from "./kernelManager.ts";
import { channel, Logger } from "./logging.ts";
import * as cmds from "./commands.ts";

export async function activate(context: vscode.ExtensionContext) {
  Logger.info("Extension.Lifecycle", "Activating marimo-lsp", {
    extensionPath: context.extensionPath,
    workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  });

  const controller = new AbortController();
  const client = new lsp.LanguageClient(
    "marimo-lsp",
    "Marimo Language Server",
    // NOTE: Dev-only config. We haven't solved LSP bundling yet. This setup
    // allows us to run the dev version of the Python LSP within the project
    // so we can iterate on both parts together. Must change before publishing.
    {
      run: {
        command: "uv",
        args: ["run", "--offline", "--directory", __dirname, "marimo-lsp"],
        transport: lsp.TransportKind.stdio,
      },
      debug: {
        command: "uv",
        args: ["run", "--offline", "--directory", __dirname, "marimo-lsp"],
        transport: lsp.TransportKind.stdio,
      },
    },
    {
      outputChannel: channel,
      revealOutputChannelOn: lsp.RevealOutputChannelOn.Never,
      middleware: {
        notebooks: {
          didOpen(notebookDocument, cells, next) {
            Logger.trace(
              "Notebook.Middleware",
              `didOpen: ${notebookDocument.uri.toString()}`,
              { cellCount: cells.length },
            );
            return next(notebookDocument, cells);
          },
          /**
           * Filters notebook change events before sending to the LSP server.
           * VS Code fires this on every change including UI updates (outputs, execution state),
           * but the marimo LSP only needs to update its dataflow graph when actual code changes.
           * We filter out UI-only events to reduce unnecessary LSP traffic.
           *
           * TODO: Could add debouncing to reduce per-keystroke updates in the future.
           */
          didChange(event, next) {
            const hasContentChanges =
              // Text content changed
              !!event.cells?.textContent ||
              // Structure changed (cells added/removed/reordered)
              !!event.cells?.structure;

            if (!hasContentChanges) {
              // Skip UI-only changes (outputs, execution state, metadata)
              Logger.trace(
                "Notebook.Middleware",
                `didChange: Filtered UI-only change for ${event.notebook.uri.toString()}`,
              );
              return Promise.resolve();
            }

            Logger.debug(
              "Notebook.Middleware",
              `didChange: Forwarding content change for ${event.notebook.uri.toString()}`,
              {
                hasTextContent: !!event.cells?.textContent,
                hasStructure: !!event.cells?.structure,
              },
            );
            return next(event);
          },
          didClose(notebookDocument, cells, next) {
            Logger.trace(
              "Notebook.Middleware",
              `didClose: ${notebookDocument.uri.toString()}`,
              { cellCount: cells.length },
            );
            return next(notebookDocument, cells);
          },
          didSave(notebookDocument, next) {
            Logger.debug(
              "Notebook.Middleware",
              `didSave: ${notebookDocument.uri.toString()}`,
            );
            return next(notebookDocument);
          },
        },
        sendRequest(type, param, token, next) {
          const method = typeof type === "string" ? type : type.method;
          // Only log non-notebook requests at trace level to reduce noise
          if (!method.startsWith("notebookDocument/")) {
            Logger.trace("LSP.Request", method, param);
          }
          return next(type, param, token);
        },
        sendNotification(type, next, params) {
          const method = typeof type === "string" ? type : type.method;
          // Only log non-notebook notifications at trace level to reduce noise
          if (!method.startsWith("notebookDocument/")) {
            Logger.trace("LSP.Notification", method, params);
          }
          return next(type, params);
        },
      },
    },
  );
  kernelManager(client, { signal: controller.signal });

  context.subscriptions.push(
    { dispose: () => controller.abort() },
    client,
    vscode.workspace.registerNotebookSerializer(
      MarimoNotebookSerializer.notebookType,
      new MarimoNotebookSerializer(client),
    ),
    cmds.registerCommand("marimo-lsp.newMarimoNotebook", async () => {
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
      Logger.info("Command", "Created new marimo notebook", {
        uri: doc.uri.toString(),
      });
    }),
  );

  await client.start().then(() => {
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
  }).catch((error) => {
    Logger.error("Extension.Lifecycle", "Failed to start LSP client", error);
    vscode.window.showErrorMessage(
      `Marimo language server failed to start ${JSON.stringify(error.message)}`,
    );
  });
  Logger.info("Extension.Lifecycle", "Activation complete");
}

export async function deactivate() {
  Logger.info("Extension.Lifecycle", "Deactivating marimo-lsp");
  Logger.close();
}
