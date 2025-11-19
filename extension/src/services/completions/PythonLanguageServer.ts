import { Data, Effect, Option } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageclient/node";

export class PythonLanguageServerStartError extends Data.TaggedError(
  "PythonLanguageServerStartError",
)<{
  cause: unknown;
}> {}

/**
 * Manages a dedicated Python language server instance (using ty via uvx)
 * for marimo notebooks. Provides LSP features (completions, hover, definitions) for
 * virtual documents without requiring disk I/O.
 */
export class PythonLanguageServer extends Effect.Service<PythonLanguageServer>()(
  "PythonLanguageServer",
  {
    scoped: Effect.gen(function* () {
      yield* Effect.logInfo("Starting Python language server (ty) for marimo");

      // Virtual document store
      const documents = new Map<string, { version: number }>();

      const serverOptions: lsp.ServerOptions = {
        command: "uv",
        args: ["tool", "run", "ty", "server"],
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

      const getClient = yield* Effect.cached(
        Effect.tryPromise({
          try: async () => {
            const client = new lsp.LanguageClient(
              "marimo-python-ls",
              "Marimo Python Language Server",
              serverOptions,
              clientOptions,
            );
            await client.start();
            return client;
          },
          catch: (cause) => new PythonLanguageServerStartError({ cause }),
        }).pipe(
          Effect.tapError((error) =>
            Effect.logError("Error starting Python language server", { error }),
          ),
          Effect.option,
        ),
      );

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.logInfo("Stopping Python language server for marimo");
          const client = yield* getClient;
          if (Option.isSome(client)) {
            yield* Effect.promise(() => client.value.stop());
          }
        }),
      );

      return {
        /**
         * Open a virtual Python document in the language server
         */
        openDocument: Effect.fnUntraced(function* (
          uri: vscode.Uri,
          content: string,
        ) {
          documents.set(uri.toString(), { version: 1 });
          const client = yield* getClient;

          if (Option.isNone(client)) {
            // Language server failed to start
            return;
          }

          yield* Effect.promise(() =>
            client.value.sendNotification("textDocument/didOpen", {
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
        updateDocument: Effect.fnUntraced(function* (
          uri: vscode.Uri,
          content: string,
        ) {
          const doc = documents.get(uri.toString());
          const version = (doc?.version ?? 0) + 1;
          documents.set(uri.toString(), { version });

          const client = yield* getClient;
          if (Option.isNone(client)) {
            // Language server failed to start
            return;
          }

          yield* Effect.promise(() =>
            client.value.sendNotification("textDocument/didChange", {
              textDocument: { uri: uri.toString(), version },
              contentChanges: [{ text: content }],
            }),
          );
        }),

        /**
         * Close virtual document
         */
        closeDocument: Effect.fnUntraced(function* (uri: string) {
          documents.delete(uri);

          const client = yield* getClient;
          if (Option.isNone(client)) {
            // Language server failed to start
            return;
          }

          yield* Effect.promise(() =>
            client.value.sendNotification("textDocument/didClose", {
              textDocument: { uri: uri.toString() },
            }),
          );
        }),

        /**
         * Get completions at a position
         */
        getCompletions: Effect.fnUntraced(function* (
          uri: vscode.Uri,
          position: lsp.Position,
          context?: lsp.CompletionContext,
        ) {
          const client = yield* getClient;

          if (Option.isNone(client)) {
            // Language server failed to start
            return null;
          }

          return yield* Effect.promise(() =>
            client.value.sendRequest<lsp.CompletionList | null>(
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
        getHover: Effect.fnUntraced(function* (
          uri: vscode.Uri,
          position: lsp.Position,
        ) {
          const client = yield* getClient;
          if (Option.isNone(client)) {
            // Language server failed to start
            return null;
          }

          return yield* Effect.promise(() =>
            client.value.sendRequest<lsp.Hover | null>("textDocument/hover", {
              textDocument: { uri: uri.toString() },
              position,
            }),
          );
        }),

        /**
         * Get definition locations
         */
        getDefinition: Effect.fnUntraced(function* (
          uri: vscode.Uri,
          position: lsp.Position,
        ) {
          const client = yield* getClient;
          if (Option.isNone(client)) {
            // Language server failed to start
            return null;
          }
          return yield* Effect.promise(() =>
            client.value.sendRequest<
              lsp.Location[] | lsp.LocationLink[] | null
            >("textDocument/definition", {
              textDocument: { uri: uri.toString() },
              position,
            }),
          );
        }),

        /**
         * Get signature help
         */
        getSignatureHelp: Effect.fnUntraced(function* (
          uri: vscode.Uri,
          position: lsp.Position,
          context?: lsp.SignatureHelpContext,
        ) {
          const client = yield* getClient;
          if (Option.isNone(client)) {
            // Language server failed to start
            return null;
          }
          return yield* Effect.promise(() =>
            client.value.sendRequest<lsp.SignatureHelp | null>(
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
        setEnvironment: Effect.fnUntraced(function* (pythonPath: string) {
          const client = yield* getClient;
          if (Option.isNone(client)) {
            // Language server failed to start
            return;
          }

          yield* Effect.logInfo("Configuring Python environment").pipe(
            Effect.annotateLogs({ pythonPath }),
          );

          yield* Effect.promise(() =>
            client.value.sendNotification("workspace/didChangeConfiguration", {
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
) {}
