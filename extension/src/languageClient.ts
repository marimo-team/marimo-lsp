import * as lsp from "vscode-languageclient/node";

import { channel, Logger } from "./logging.ts";

export function languageClient(opts: {
  signal: AbortSignal;
}): lsp.BaseLanguageClient {
  const client = new lsp.LanguageClient(
    "marimo-lsp",
    "Marimo Language Server",
    // NOTE: Dev-only config. We haven't solved LSP bundling yet. This setup
    // allows us to run the dev version of the Python LSP within the project
    // so we can iterate on both parts together. Must change before publishing.
    {
      run: {
        command: "uv",
        args: ["run", "--directory", __dirname, "marimo-lsp"],
        transport: lsp.TransportKind.stdio,
      },
      debug: {
        command: "uv",
        args: ["run", "--directory", __dirname, "marimo-lsp"],
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

  opts.signal.addEventListener("abort", () => {
    client.dispose();
  });

  return client;
}
