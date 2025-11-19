import { Data, Effect } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageclient/node";

export class PythonLanguageServerStartError extends Data.TaggedError(
  "PythonLanguageServerStartError",
)<{
  cause: unknown;
}> { }

/**
 * Manages a dedicated Python language server instance (using ty via uvx)
 * for marimo notebooks. Provides LSP features (completions, hover, definitions) for
 * virtual documents without requiring disk I/O.
 */
export class PythonLanguageServer extends Effect.Service<PythonLanguageServer>()(
  "PythonLanguageServer",
  {
    scoped: Effect.gen(function*() {
      yield* Effect.logInfo("Starting Python language server (ty) for marimo");

      // Virtual document store
      const documents = new Map<string, { version: number }>();

      const serverOptions: lsp.ServerOptions = {
        command: "uvx",
        args: ["ty", "server"],
        options: {
          // Run in stdio mode
        },
      };

      const clientOptions: lsp.LanguageClientOptions = {
        // No automatic document sync - we manage everything manually
        synchronize: {
          fileEvents: [],
        },
        initializationOptions: {},
      };

      const client = new lsp.LanguageClient(
        "marimo-python-ls",
        "Marimo Python Language Server",
        serverOptions,
        clientOptions,
      );

      yield* Effect.logInfo("Python language server started for marimo");

      yield* Effect.tryPromise({
        try: () => client.start(),
        catch: (cause) => new PythonLanguageServerStartError({ cause }),
      });

      yield* Effect.addFinalizer(() =>
        Effect.gen(function*() {
          yield* Effect.logInfo("Stopping Python language server for marimo");
          yield* Effect.promise(() => client.stop());
        }),
      );

      return {
        /**
         * Open a virtual Python document in the language server
         */
        openDocument: Effect.fnUntraced(function*(
          uri: vscode.Uri,
          content: string,
        ) {
          documents.set(uri.toString(), { version: 1 });

          yield* Effect.promise(() =>
            client.sendNotification("textDocument/didOpen", {
              textDocument: {
                uri: uri.toString(),
                languageId: "python",
                version: 1,
                text: content,
              },
            }),
          );
        }),

        /**
         * Update virtual document content
         */
        updateDocument: Effect.fnUntraced(function*(
          uri: vscode.Uri,
          content: string,
        ) {
          const doc = documents.get(uri.toString());
          const version = (doc?.version ?? 0) + 1;

          documents.set(uri.toString(), { version });

          yield* Effect.promise(() =>
            client.sendNotification("textDocument/didChange", {
              textDocument: { uri: uri.toString(), version },
              contentChanges: [{ text: content }],
            }),
          );
        }),

        /**
         * Close virtual document
         */
        closeDocument: Effect.fnUntraced(function*(uri: string) {
          documents.delete(uri);

          yield* Effect.promise(() =>
            client.sendNotification("textDocument/didClose", {
              textDocument: { uri: uri.toString() },
            }),
          );
        }),

        /**
         * Get completions at a position
         */
        getCompletions: Effect.fnUntraced(function*(
          uri: vscode.Uri,
          position: lsp.Position,
          context?: lsp.CompletionContext,
        ) {
          return yield* Effect.promise(() =>
            client.sendRequest<lsp.CompletionList | null>(
              "textDocument/completion",
              {
                textDocument: { uri: uri.toString() },
                position,
                context,
              },
            ),
          );
        }),

        /**
         * Get hover information
         */
        getHover: Effect.fnUntraced(function*(
          uri: vscode.Uri,
          position: lsp.Position,
        ) {
          return yield* Effect.promise(() =>
            client.sendRequest<lsp.Hover | null>("textDocument/hover", {
              textDocument: { uri: uri.toString() },
              position,
            }),
          );
        }),

        /**
         * Get definition locations
         */
        getDefinition: Effect.fnUntraced(function*(
          uri: vscode.Uri,
          position: lsp.Position,
        ) {
          return yield* Effect.promise(() =>
            client.sendRequest<lsp.Location[] | null>(
              "textDocument/definition",
              {
                textDocument: { uri: uri.toString() },
                position,
              },
            ),
          );
        }),

        /**
         * Get signature help
         */
        getSignatureHelp: Effect.fnUntraced(function*(
          uri: vscode.Uri,
          position: lsp.Position,
          context?: lsp.SignatureHelpContext,
        ) {
          return yield* Effect.promise(() =>
            client.sendRequest<lsp.SignatureHelp | null>(
              "textDocument/signatureHelp",
              {
                textDocument: { uri: uri.toString() },
                position,
                context,
              },
            ),
          );
        }),

        /**
         * Configure Python environment path for the language server
         */
        setEnvironment: Effect.fnUntraced(function*(pythonPath: string) {
          yield* Effect.logInfo("Configuring Python environment").pipe(
            Effect.annotateLogs({ pythonPath }),
          );

          yield* Effect.promise(() =>
            client.sendNotification("workspace/didChangeConfiguration", {
              settings: {
                python: {
                  pythonPath,
                  analysis: {
                    autoSearchPaths: true,
                    diagnosticMode: "openFilesOnly",
                    useLibraryCodeForTypes: true,
                  },
                },
              },
            }),
          );
        }),
      };
    }),
  },
) { }
