import { Data, Effect, Either, Option, Runtime, Stream } from "effect";
import type * as lsp from "vscode-languageclient/node";
import { ResponseError } from "vscode-languageclient/node";
import { NamespacedLanguageClient } from "../../utils/NamespacedLanguageClient.ts";
import { signalFromToken } from "../../utils/signalFromToken.ts";
import { Config } from "../Config.ts";
import { PythonExtension } from "../PythonExtension.ts";
import { Sentry } from "../Sentry.ts";
import { Uv } from "../Uv.ts";
import { VsCode } from "../VsCode.ts";
import { VariablesService } from "../variables/VariablesService.ts";
import {
  type ClientNotebookSync,
  NotebookSyncService,
} from "./NotebookSyncService.ts";

// TODO: make TY_VERSION configurable?
// For now, since we are doing rolling releases, we can bump this as needed.
const TY_VERSION = "0.0.14";

export class TyLanguageServerStartError extends Data.TaggedError(
  "TyLanguageServerStartError",
)<{
  cause: unknown;
}> {}

export const TyLanguageServerHealth = Data.taggedEnum<TyLanguageServerHealth>();

type TyLanguageServerHealth = Data.TaggedEnum<{
  Running: {
    readonly version: Option.Option<string>;
    readonly pythonEnvironment: Option.Option<{
      path: string;
      version: string | null;
    }>;
  };
  Failed: { readonly error: string };
}>;

/**
 * Manages a dedicated ty language server instance (using ty via uvx)
 * for marimo notebooks. Provides LSP features (completions, hover, definitions,
 * signature help, semantic tokens) for notebook cells.
 *
 * ty has native notebook support. We configure automatic notebook sync
 * and use middleware to map mo-python -> python language IDs and enrich
 * configuration with Python environment information.
 */
export class TyLanguageServer extends Effect.Service<TyLanguageServer>()(
  "TyLanguageServer",
  {
    dependencies: [VariablesService.Default, NotebookSyncService.Default],
    scoped: Effect.gen(function* () {
      const uv = yield* Uv;
      const pyExt = yield* PythonExtension;
      const sync = yield* NotebookSyncService;
      const sentry = yield* Effect.serviceOption(Sentry);

      const disabledHealth = yield* checkTyEnabled();
      if (Option.isSome(disabledHealth)) {
        return {
          getHealthStatus: Effect.succeed(disabledHealth.value),
          restart: () => Effect.void,
        };
      }

      yield* Effect.logInfo("Starting ty language server for marimo");

      // Create isolated sync instance with its own cell count tracking
      const notebookSync = yield* sync.forClient();

      const serverOptions: lsp.ServerOptions = {
        command: uv.bin.executable,
        args: ["tool", "run", `ty@${TY_VERSION}`, "server"],
        options: {},
      };

      const clientOptions: lsp.LanguageClientOptions = {
        outputChannelName: "marimo (ty)",
        middleware: yield* createTyMiddleware(notebookSync),
        documentSelector: sync.getDocumentSelector(),
        transformServerCapabilities: sync.extendNotebookCellLanguages(),
        initializationOptions: {},
      };

      const getClient = yield* Effect.tryPromise({
        try: async () => {
          const client = new NamespacedLanguageClient(
            "marimo-ty",
            "marimo (ty)",
            serverOptions,
            clientOptions,
          );
          await client.start();
          return client;
        },
        catch: (cause) => new TyLanguageServerStartError({ cause }),
      }).pipe(
        Effect.tapError((error) =>
          Effect.logError("Error starting ty language server", { error }),
        ),
        Effect.either,
        Effect.cached,
      );

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.logInfo("Stopping ty language server for marimo");
          const c = yield* getClient;
          if (Either.isRight(c)) {
            yield* Effect.promise(() => c.right.stop());
          }
        }),
      );

      const client = yield* getClient;

      if (Either.isRight(client)) {
        if (Option.isSome(sentry)) {
          yield* sentry.value.setTag(
            "ty.version",
            client.right.initializeResult?.serverInfo?.version ?? "unknown",
          );
        }
        yield* notebookSync.connect(client.right);
        yield* Effect.logInfo("ty language server started successfully");
      } else {
        yield* Effect.logInfo("ty language server failed to start");
      }

      const restartServer = Effect.fn(function* (reason: string) {
        if (Either.isLeft(client)) {
          yield* Effect.logWarning(
            "Cannot restart ty language server: client failed to start",
          );
          return;
        }
        yield* Effect.logInfo(
          `Restarting ty language server for marimo: ${reason}`,
        );
        yield* Effect.promise(() => client.right.stop());
        yield* Effect.promise(() => client.right.start());
        yield* Effect.logInfo("ty language server for marimo restarted");
      });

      // Restart the language server when Python environment changes
      // ty needs restart to pick up environment changes since it doesn't
      // support workspace/didChangeConfiguration for environment updates
      yield* Effect.forkScoped(
        pyExt.activeEnvironmentPathChanges().pipe(
          Stream.mapEffect((event) =>
            restartServer(`Python environment changed to: ${event.path}`),
          ),
          Stream.runDrain,
        ),
      );

      return {
        getHealthStatus: Effect.gen(function* () {
          const [client, path] = yield* Effect.all([
            getClient,
            pyExt.getActiveEnvironmentPath(),
          ]);
          const resolved = yield* pyExt.resolveEnvironment(path);
          return Either.match(client, {
            onLeft: (error) =>
              TyLanguageServerHealth.Failed({ error: String(error.cause) }),
            onRight: (client) =>
              TyLanguageServerHealth.Running({
                version: Option.fromNullable(
                  client.initializeResult?.serverInfo?.version,
                ),
                pythonEnvironment: Option.map(resolved, (env) => ({
                  path: env.executable.uri?.fsPath ?? env.path ?? "Unknown",
                  version: env.version?.sysVersion ?? null,
                })),
              }),
          });
        }),

        /**
         * Restart the language server to pick up new packages or environment changes.
         * This is useful after installing packages, as ty doesn't support
         * workspace/didChangeConfiguration.
         */
        restart: (reason: string) => restartServer(reason),
      };
    }),
  },
) {}

interface InitializationOptions {
  logLevel?: "error" | "warn" | "info" | "debug" | "trace";
  logFile?: string;
}

interface ExtensionSettings {
  cwd: string;
  path: string[];
  interpreter: string[];
  importStrategy: "fromEnvironment" | "useBundled";
}

// Keys that are handled by the extension and should not be sent to the server
type ExtensionOnlyKeys =
  | keyof InitializationOptions
  | keyof ExtensionSettings
  | "trace";

/**
 * Keys that are handled by the extension and should not be sent to the ty server.
 * These are extension-specific settings that the server doesn't recognize.
 *
 * Adapted from https://github.com/astral-sh/ty-vscode/blob/221a8d1a/src/client.ts
 */
const EXTENSION_ONLY_KEYS = {
  // InitializationOptions
  logLevel: true,
  logFile: true,
  // ExtensionSettings
  cwd: true,
  path: true,
  interpreter: true,
  importStrategy: true,
  // Client-handled settings
  trace: true,
} as const satisfies Record<ExtensionOnlyKeys, true>;

function isExtensionOnlyKey(key: string): key is ExtensionOnlyKeys {
  return key in EXTENSION_ONLY_KEYS;
}

/**
 * Creates LSP middleware that adapts marimo notebook documents for ty.
 *
 * Uses the provided notebook middleware for base notebook handling,
 * and adds ty-specific workspace configuration middleware to enrich
 * responses with Python environment information.
 */
function createTyMiddleware(
  sync: ClientNotebookSync,
): Effect.Effect<lsp.Middleware, never, VsCode | PythonExtension> {
  return Effect.gen(function* () {
    const runtime = yield* Effect.runtime<VsCode | PythonExtension>();
    const runPromise = Runtime.runPromise(runtime);

    // Helper to wrap document with language ID mapping (mo-python -> python)
    const wrapDocument = sync.adapter.document.bind(sync.adapter);

    return {
      notebooks: sync.notebookMiddleware,
      // Language ID mapping for request handlers
      // ty needs "python" language ID, but marimo uses "mo-python" to avoid conflicts
      didOpen: (doc, next) => next(wrapDocument(doc)),
      didClose: (doc, next) => next(wrapDocument(doc)),
      didChange: (change, next) =>
        next({ ...change, document: wrapDocument(change.document) }),
      provideHover: (doc, position, token, next) =>
        next(wrapDocument(doc), position, token),
      provideDefinition: (doc, position, token, next) =>
        next(wrapDocument(doc), position, token),
      provideTypeDefinition: (doc, position, token, next) =>
        next(wrapDocument(doc), position, token),
      provideReferences: (doc, position, context, token, next) =>
        next(wrapDocument(doc), position, context, token),
      provideRenameEdits: (doc, position, newName, token, next) =>
        next(wrapDocument(doc), position, newName, token),
      prepareRename: (doc, position, token, next) =>
        next(wrapDocument(doc), position, token),
      provideCompletionItem: (doc, position, context, token, next) =>
        next(wrapDocument(doc), position, context, token),
      provideSignatureHelp: (doc, position, context, token, next) =>
        next(wrapDocument(doc), position, context, token),
      provideDocumentHighlights: (doc, position, token, next) =>
        next(wrapDocument(doc), position, token),
      provideDocumentSymbols: (doc, token, next) =>
        next(wrapDocument(doc), token),
      provideInlayHints: (doc, range, token, next) =>
        next(wrapDocument(doc), range, token),

      // WORKAROUND: ty panics when receiving textDocument/diagnostic for (.py) notebook
      // cells because it only supports text document diagnostics, not notebook
      // documents. We suppress these requests client-side until ty adds full
      // notebook diagnostics support.
      provideDiagnostics(doc, previousResultId, token, next) {
        const uri = "scheme" in doc ? doc : doc.uri;
        if (uri.scheme === "vscode-notebook-cell") {
          return null;
        }
        return next(uri, previousResultId, token);
      },
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
                  const code = yield* VsCode;
                  const pythonExtension = yield* PythonExtension;

                  const result = response[index];

                  // Only enrich ty configuration requests
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

                    // Filter out extension-only settings that shouldn't be sent to the server
                    const serverSettings = Object.fromEntries(
                      Object.entries(result ?? {}).filter(
                        ([key]) => !isExtensionOnlyKey(key),
                      ),
                    );

                    return {
                      ...serverSettings,
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
  });
}

/**
 * Checks if the managed ty language server should be enabled.
 * Returns Some(FailedHealth) if disabled, None if enabled.
 */
const checkTyEnabled = Effect.fn(function* () {
  const config = yield* Config;

  const managedFeaturesEnabled =
    yield* config.getManagedLanguageFeaturesEnabled();

  if (!managedFeaturesEnabled) {
    yield* Effect.logInfo(
      "Managed language features are disabled. Not starting managed ty language server.",
    );
    return Option.some(
      TyLanguageServerHealth.Failed({
        error: "Managed language features are disabled in marimo settings.",
      }),
    );
  }

  return Option.none();
});
