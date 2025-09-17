import * as vscode from "vscode";
import type * as lsp from "vscode-languageclient";

import { assert } from "./assert.ts";
import * as cmds from "./commands.ts";
import { Logger } from "./logging.ts";
import { createNotebookControllerManager } from "./notebookControllerManager.ts";
import { registerNotificationHandler } from "./notifications.ts";
import * as ops from "./operations.ts";
import type { RendererCommand } from "./types.ts";

export function kernelManager(
  client: lsp.BaseLanguageClient,
  options: { signal: AbortSignal },
) {
  const manager = createNotebookControllerManager(client, options);

  const channel = vscode.notebooks.createRendererMessaging("marimo-renderer");
  channel.onDidReceiveMessage(
    async (data: {
      editor: vscode.NotebookEditor;
      message: RendererCommand;
    }) => {
      const { editor, message } = data;
      assert("command" in message && "params" in message, "unknown message");
      // route renderer command with notebook_uri
      await cmds.executeCommand(client, {
        command: message.command,
        params: {
          notebookUri: editor.notebook.uri.toString(),
          inner: message.params,
        },
      });
    },
  );

  const contexts = new Map<string, Omit<ops.OperationContext, "controller">>();

  registerNotificationHandler(client, {
    method: "marimo/operation",
    callback: async (message) => {
      const { notebookUri, operation } = message;
      let context = contexts.get(notebookUri);
      if (!context) {
        const notebook = vscode.workspace.notebookDocuments.find(
          (doc) => doc.uri.toString() === notebookUri,
        );
        assert(notebook, `Expected notebook document for ${notebookUri}`);
        context = { notebook, executions: new Map() };
        contexts.set(notebookUri, context);
      }
      const controller = manager.getSelectedController(context.notebook);
      assert(controller, `Expected notebook controller for ${notebookUri}`);
      await ops.route({ ...context, controller }, operation);
    },
    signal: options.signal,
  });

  options.signal.addEventListener("abort", () => {
    contexts.clear();
    Logger.info("Kernel.Lifecycle", "Kernel manager disposed");
  });

  Logger.info("Kernel.Lifecycle", "Kernel manager initialized");
}
