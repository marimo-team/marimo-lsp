import { Data, Effect, Option, Ref, Runtime, Stream } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageclient/node";
import { type Middleware, ResponseError } from "vscode-languageclient/node";
import { signalFromToken } from "../../utils/signalFromToken.ts";
import { PythonExtension } from "../PythonExtension.ts";
import { Uv } from "../Uv.ts";
import { VsCode } from "../VsCode.ts";

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
    dependencies: [Uv.Default],
    scoped: Effect.gen(function* () {
      yield* Effect.logInfo("Starting Python language server (ty) for marimo");

      const uv = yield* Uv;
      const code = yield* VsCode;
      const pyExt = yield* PythonExtension;

      // Virtual document store
      const documents = new Map<string, { version: number; content: string }>();

      const serverOptions: lsp.ServerOptions = {
        command: uv.bin.executable,
        args: ["tool", "run", "ty", "server"],
        options: {
          // Run in stdio mode
        },
      };

      // Create middleware to enrich configuration with Python environment
      const middleware = yield* createTyMiddleware(pyExt, code);

      const clientOptions: lsp.LanguageClientOptions = {
        // No automatic document sync - we manage everything manually
        synchronize: {
          fileEvents: [],
        },
        initializationOptions: {},
        middleware,
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

      // Track if we're currently restarting to prevent document operations
      const isRestarting = yield* Ref.make(false);

      // Restart the language server when Python environment changes
      // Note: ty server does not support workspace/didChangeConfiguration yet,
      // so we need to restart the server to pick up the new Python environment.
      yield* Effect.forkScoped(
        pyExt.activeEnvironmentPathChanges().pipe(
          Stream.mapEffect((event) =>
            Effect.gen(function* () {
              yield* Effect.logInfo(
                `Python environment changed to: ${event.path}, restarting language server...`,
              );

              const client = yield* getClient;
              if (Option.isNone(client)) {
                yield* Effect.logWarning(
                  "Language server not available, skipping restart",
                );
                return;
              }

              // Mark as restarting
              yield* Ref.set(isRestarting, true);

              // Store currently open documents before restarting
              const openDocs = Array.from(documents.entries());
              yield* Effect.logInfo(
                `Storing ${openDocs.length} virtual documents for reopening`,
              );

              // Stop the current client
              yield* Effect.promise(() => client.value.stop());
              yield* Effect.logInfo("Python language server stopped");

              // Start it again - it will get the enriched configuration on init
              yield* Effect.promise(() => client.value.start());
              yield* Effect.logInfo(
                "Python language server restarted successfully",
              );

              // Reopen all virtual documents that were open before restart
              for (const [uriString, doc] of openDocs) {
                yield* Effect.logDebug(
                  `Reopening virtual document: ${uriString}`,
                );
                yield* Effect.promise(() =>
                  client.value.sendNotification("textDocument/didOpen", {
                    textDocument: {
                      uri: uriString,
                      languageId: "python",
                      version: 1, // Reset version to 1 for new server instance
                      text: doc.content,
                    },
                  }),
                );
                // Reset version in our map too
                documents.set(uriString, { version: 1, content: doc.content });
              }

              yield* Effect.logInfo(
                `Reopened ${openDocs.length} virtual documents`,
              );

              // Mark as no longer restarting
              yield* Ref.set(isRestarting, false);
            }),
          ),
          Stream.runDrain,
        ),
      );

      return {
        /**
         * Open a virtual Python document in the language server
         */
        openDocument: Effect.fnUntraced(function* (
          uri: vscode.Uri,
          content: string,
        ) {
          documents.set(uri.toString(), { version: 1, content });
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
          // Skip updates if we're restarting the server
          const restarting = yield* Ref.get(isRestarting);
          if (restarting) {
            yield* Effect.logDebug(
              "Skipping document update during server restart",
            );
            // Still update our local cache
            const doc = documents.get(uri.toString());
            const version = (doc?.version ?? 0) + 1;
            documents.set(uri.toString(), { version, content });
            return;
          }

          const doc = documents.get(uri.toString());
          const version = (doc?.version ?? 0) + 1;
          documents.set(uri.toString(), { version, content });

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
         * Get the semantic tokens legend from the language server.
         * This must be called once during initialization to know how to
         * interpret semantic token data.
         */
        getSemanticTokensLegend: () =>
          Effect.gen(function* () {
            const client = yield* getClient;
            if (Option.isNone(client)) {
              return null;
            }

            // Get the server capabilities to find the semantic tokens legend
            const semanticTokensProvider =
              client.value.initializeResult?.capabilities
                ?.semanticTokensProvider;

            if (!semanticTokensProvider) {
              return null;
            }

            // The legend is part of the provider options
            if ("legend" in semanticTokensProvider) {
              return semanticTokensProvider.legend;
            }

            return null;
          }).pipe(Effect.map(Option.fromNullable)),

        /**
         * Get semantic tokens for the full document
         */
        getSemanticTokensFull: (uri: vscode.Uri) =>
          Effect.gen(function* () {
            const client = yield* getClient;
            if (Option.isNone(client)) {
              return null;
            }
            return yield* Effect.promise(() =>
              client.value.sendRequest<lsp.SemanticTokens | null>(
                "textDocument/semanticTokens/full",
                { textDocument: { uri: uri.toString() } },
              ),
            );
          }).pipe(Effect.map(Option.fromNullable)),

        /**
         * Get semantic tokens for a range within the document
         */
        getSemanticTokensRange: Effect.fnUntraced(function* (
          uri: vscode.Uri,
          range: lsp.Range,
        ) {
          const client = yield* getClient;
          if (Option.isNone(client)) {
            return null;
          }

          return yield* Effect.promise(() =>
            client.value.sendRequest<lsp.SemanticTokens | null>(
              "textDocument/semanticTokens/range",
              {
                textDocument: { uri: uri.toString() },
                range,
              },
            ),
          );
        }),
      };
    }),
  },
) {}

/**
 * Creates middleware that enriches workspace/configuration responses
 * with active Python environment information from the Python extension.
 *
 * Adapted from https://github.com/astral-sh/ty-vscode/blob/fdc8684e/src/client.ts
 */
function createTyMiddleware(
  pythonExtension: PythonExtension,
  code: VsCode,
): Effect.Effect<Middleware> {
  return Effect.gen(function* () {
    const runtime = yield* Effect.runtime();
    const runPromise = Runtime.runPromise(runtime);

    const middleware: Middleware = {
      workspace: {
        /**
         * Enriches the configuration response with the active Python environment
         * as reported by the Python extension (respecting the scope URI).
         */
        async configuration(params, token, next) {
          const response = await next(params, token);

          if (response instanceof ResponseError) {
            return response;
          }

          const enrichedResponse = await runPromise(
            Effect.all(
              params.items.map(
                Effect.fnUntraced(function* (param, index) {
                  const result = response[index];

                  // Only enrich ty configuration requests (for the Python language server)
                  if (param.section === "ty") {
                    const scopeUri = param.scopeUri
                      ? code.Uri.parse(param.scopeUri, true)
                      : undefined;

                    const path =
                      yield* pythonExtension.getActiveEnvironmentPath(scopeUri);

                    const resolved =
                      yield* pythonExtension.resolveEnvironment(path);

                    const env = Option.getOrNull(resolved);

                    yield* Effect.logDebug(
                      `Enriching ty config with Python env: ${env?.path || "null"} (${env?.version?.sysVersion || "unknown version"})`,
                    );

                    const activeEnvironment =
                      env == null
                        ? null
                        : {
                            version:
                              env.version == null
                                ? null
                                : {
                                    major: env.version.major,
                                    minor: env.version.minor,
                                    patch: env.version.micro,
                                    sysVersion: env.version.sysVersion,
                                  },
                            environment:
                              env.environment == null
                                ? null
                                : {
                                    folderUri:
                                      env.environment.folderUri.toString(),
                                    name: env.environment.name,
                                    type: env.environment.type,
                                  },
                            executable: {
                              uri: env.executable.uri?.toString(),
                              sysPrefix: env.executable.sysPrefix,
                            },
                          };

                    return {
                      ...result,
                      pythonExtension: {
                        ...result?.pythonExtension,
                        activeEnvironment,
                      },
                    };
                  }

                  return result;
                }),
              ),
            ),
            { signal: signalFromToken(token) },
          );

          return enrichedResponse;
        },
      },
    };

    return middleware;
  });
}
