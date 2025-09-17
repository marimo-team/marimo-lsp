import { Effect, type Layer, pipe } from "effect";
import * as vscode from "vscode";

import { assert } from "./assert.ts";
import { Logger } from "./logging.ts";
import { createNotebookControllerManager } from "./notebookControllerManager.ts";
import { registerNotificationHandler } from "./notifications.ts";
import * as ops from "./operations.ts";
import { MarimoLanguageClient } from "./services.ts";
import type { RendererCommand } from "./types.ts";

export function kernelManager(
  layer: Layer.Layer<MarimoLanguageClient>,
  options: { signal: AbortSignal },
) {
  const manager = createNotebookControllerManager(layer, options);

  const channel = vscode.notebooks.createRendererMessaging("marimo-renderer");
  const disposer = channel.onDidReceiveMessage(
    async (data: {
      editor: vscode.NotebookEditor;
      message: RendererCommand;
    }) => {
      const { editor, message } = data;
      assert("command" in message && "params" in message, "unknown message");
      const program = pipe(
        Effect.gen(function* () {
          const marimo = yield* MarimoLanguageClient;
          return yield* marimo.setUiElementValue({
            notebookUri: editor.notebook.uri.toString(),
            inner: message.params,
          });
        }),
        Effect.provide(layer),
      );
      return Effect.runPromise(program);
    },
  );

  const contexts = new Map<string, Omit<ops.OperationContext, "controller">>();

  pipe(
    Effect.gen(function* () {
      const { client } = yield* MarimoLanguageClient;
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
    }),
    Effect.provide(layer),
    Effect.runSync,
  );

  options.signal.addEventListener("abort", () => {
    contexts.clear();
    disposer.dispose();
    Logger.info("Kernel.Lifecycle", "Kernel manager disposed");
  });

  Logger.info("Kernel.Lifecycle", "Kernel manager initialized");
}
