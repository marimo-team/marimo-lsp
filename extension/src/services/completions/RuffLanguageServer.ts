import { Data, Effect, Either, Option, Runtime, Stream } from "effect";
import type * as vscode from "vscode";
import type * as lsp from "vscode-languageclient/node";
import { NamespacedLanguageClient } from "../../utils/NamespacedLanguageClient.ts";
import { Config } from "../Config.ts";
import { Uv } from "../Uv.ts";
import { VsCode } from "../VsCode.ts";
import { VariablesService } from "../variables/VariablesService.ts";
import { NotebookSyncService } from "./NotebookSyncService.ts";

// Pin Ruff version for stability, matching ruff-vscode's approach.
// Bump this as needed for new features or fixes.
const RUFF_VERSION = "0.11.13";
const RUFF_EXTENSION_ID = "charliermarsh.ruff";

export class RuffLanguageServerStartError extends Data.TaggedError(
  "RuffLanguageServerStartError",
)<{
  cause: unknown;
}> {}

export const RuffLanguageServerHealth =
  Data.taggedEnum<RuffLanguageServerHealth>();

type RuffLanguageServerHealth = Data.TaggedEnum<{
  Running: { readonly version: Option.Option<string> };
  Failed: { readonly error: string };
}>;

/**
 * Manages a dedicated Ruff language server instance (using ruff via uvx)
 * for marimo notebooks. Provides linting diagnostics for notebook cells.
 *
 * Ruff has native notebook support. We configure automatic notebook sync
 * and use middleware to map mo-python -> python language IDs.
 */
export class RuffLanguageServer extends Effect.Service<RuffLanguageServer>()(
  "RuffLanguageServer",
  {
    dependencies: [VariablesService.Default, NotebookSyncService.Default],
    scoped: Effect.gen(function* () {
      const uv = yield* Uv;
      const code = yield* VsCode;
      const sync = yield* NotebookSyncService;

      const disabledHealth = yield* checkRuffEnabled();
      if (Option.isSome(disabledHealth)) {
        return {
          getHealthStatus: Effect.succeed(disabledHealth.value),
        };
      }

      yield* Effect.logInfo("Starting Ruff language server for marimo");

      // Build initializationOptions from ruff.* settings
      const ruffConfig = yield* code.workspace.getConfiguration("ruff");
      const workspaceFolders = yield* code.workspace.getWorkspaceFolders();
      const settings = Option.getOrElse(workspaceFolders, () => []).map(
        (folder) => getRuffSettings(ruffConfig, folder),
      );
      const globalSettings = getGlobalRuffSettings(ruffConfig);

      yield* Effect.logDebug("Ruff initialization options", {
        settings,
        globalSettings,
      });

      const clientOptions: lsp.LanguageClientOptions = {
        outputChannelName: "marimo (ruff)",
        middleware: yield* createRuffMiddleware(sync),
        documentSelector: sync.getDocumentSelector(),
        transformServerCapabilities: sync.extendNotebookCellLanguages(),
        initializationOptions: { settings, globalSettings },
      };

      const serverOptions: lsp.ServerOptions = {
        command: uv.bin.executable,
        args: ["tool", "run", `ruff@${RUFF_VERSION}`, "server"],
        options: {},
      };

      const getClient = yield* Effect.tryPromise({
        try: async () => {
          const client = new NamespacedLanguageClient(
            "marimo-ruff",
            "marimo (ruff)",
            serverOptions,
            clientOptions,
          );
          await client.start();
          return client;
        },
        catch: (cause) => new RuffLanguageServerStartError({ cause }),
      }).pipe(
        Effect.tapError((error) =>
          Effect.logError("Error starting Ruff language server", { error }),
        ),
        Effect.either,
        Effect.cached,
      );

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.logInfo("Stopping Ruff language server for marimo");
          const c = yield* getClient;
          if (Either.isRight(c)) {
            yield* Effect.promise(() => c.right.stop());
          }
        }),
      );

      const restartServer = Effect.fn(function* () {
        const c = yield* getClient;
        if (Either.isLeft(c)) {
          return;
        }
        yield* Effect.logInfo("Restarting Ruff language server for marimo");
        yield* Effect.promise(() => c.right.stop());
        yield* Effect.promise(() => c.right.start());
        yield* Effect.logInfo("Ruff language server for marimo restarted");
      });

      const client = yield* getClient;

      if (Either.isRight(client)) {
        yield* sync.registerClient(client.right);
        yield* Effect.logInfo("Ruff language server started successfully");
      } else {
        yield* Effect.logInfo("Ruff language server failed to start");
      }

      // Restart the language server when ruff.* settings change
      yield* Effect.forkScoped(
        code.workspace.configurationChanges().pipe(
          Stream.filter((event) => event.affectsConfiguration("ruff")),
          Stream.mapEffect(restartServer),
          Stream.runDrain,
        ),
      );

      return {
        getHealthStatus: Effect.gen(function* () {
          const c = yield* getClient;
          return Either.match(c, {
            onLeft: (error) =>
              RuffLanguageServerHealth.Failed({
                error: String(error.cause),
              }),
            onRight: (client) =>
              RuffLanguageServerHealth.Running({
                version: Option.fromNullable(
                  client.initializeResult?.serverInfo?.version,
                ),
              }),
          });
        }),
      };
    }),
  },
) {}

/**
 * Read ruff.* settings from a WorkspaceConfiguration and return them in the format
 * expected by the Ruff language server's initializationOptions.
 *
 * Based on ruff-vscode's getWorkspaceSettings:
 * https://github.com/astral-sh/ruff-vscode/blob/main/src/common/settings.ts
 */
function getRuffSettings(
  config: vscode.WorkspaceConfiguration,
  folder: vscode.WorkspaceFolder,
): Record<string, unknown> {
  return {
    cwd: folder.uri.fsPath,
    workspace: folder.uri.toString(),
    configuration: config.get("configuration") ?? null,
    configurationPreference:
      config.get("configurationPreference") ?? "editorFirst",
    lineLength: config.get("lineLength"),
    exclude: config.get("exclude"),
    lint: {
      enable: config.get("lint.enable") ?? true,
      preview: config.get("lint.preview"),
      select: config.get("lint.select"),
      extendSelect: config.get("lint.extendSelect"),
      ignore: config.get<string[]>("lint.ignore", []),
    },
    format: {
      preview: config.get("format.preview"),
      backend: config.get("format.backend") ?? "internal",
    },
    codeAction: config.get("codeAction") ?? {},
    organizeImports: config.get("organizeImports") ?? true,
    fixAll: config.get("fixAll") ?? true,
    showSyntaxErrors: config.get("showSyntaxErrors") ?? true,
    logLevel: config.get("logLevel"),
    logFile: config.get("logFile"),
  };
}

/**
 * Read global ruff.* settings (not workspace-specific).
 *
 * Based on ruff-vscode's getGlobalSettings:
 * https://github.com/astral-sh/ruff-vscode/blob/main/src/common/settings.ts
 */
function getGlobalRuffSettings(
  config: vscode.WorkspaceConfiguration,
): Record<string, unknown> {
  const getGlobal = <T>(key: string, defaultValue?: T): T | undefined => {
    const inspect = config.inspect<T>(key);
    return inspect?.globalValue ?? inspect?.defaultValue ?? defaultValue;
  };
  return {
    cwd: process.cwd(),
    workspace: process.cwd(),
    configuration: getGlobal("configuration", null),
    configurationPreference: getGlobal(
      "configurationPreference",
      "editorFirst",
    ),
    lineLength: getGlobal("lineLength"),
    exclude: getGlobal("exclude"),
    lint: {
      enable: getGlobal("lint.enable", true),
      preview: getGlobal("lint.preview"),
      select: getGlobal("lint.select"),
      extendSelect: getGlobal("lint.extendSelect"),
      ignore: config.get<string[]>("lint.ignore", []),
    },
    format: {
      preview: getGlobal("format.preview"),
      backend: getGlobal("format.backend", "internal"),
    },
    codeAction: getGlobal("codeAction", {}),
    organizeImports: getGlobal("organizeImports", true),
    fixAll: getGlobal("fixAll", true),
    showSyntaxErrors: getGlobal("showSyntaxErrors", true),
    logLevel: getGlobal("logLevel"),
    logFile: getGlobal("logFile"),
  };
}

/**
 * Creates LSP middleware that adapts marimo notebook documents for Ruff.
 *
 * Uses the shared NotebookSyncService for base notebook handling,
 * and adds Ruff-specific formatting and code action middleware.
 */
function createRuffMiddleware(
  sync: NotebookSyncService,
): Effect.Effect<lsp.Middleware, never, VsCode> {
  return Effect.gen(function* () {
    const runtime = yield* Effect.runtime<VsCode>();
    const runPromise = Runtime.runPromise(runtime);

    const isRuffFormatEnabled = () =>
      ruffConfiguredAsDefaultPythonFormatter().pipe(
        Effect.tap((enabled) =>
          enabled
            ? Effect.void
            : Effect.logWarning(
                `Ruff is not configured as default Python formatter; skipping marimo format.`,
              ),
        ),
        runPromise,
      );

    return {
      ...sync.notebookMiddleware,
      async provideDocumentFormattingEdits(document, options, token, next) {
        const shouldFormat = await isRuffFormatEnabled();
        return shouldFormat
          ? next(sync.adapter.document(document), options, token)
          : null;
      },
      async provideDocumentRangeFormattingEdits(
        document,
        range,
        options,
        token,
        next,
      ) {
        const shouldFormat = await isRuffFormatEnabled();
        return shouldFormat
          ? next(sync.adapter.document(document), range, options, token)
          : null;
      },
      provideCodeActions: (document, range, context, token, next) =>
        next(sync.adapter.document(document), range, context, token),
    };
  });
}

/**
 * Checks if the managed Ruff language server should be enabled.
 * Returns Some(FailedHealth) if disabled, None if enabled.
 */
const checkRuffEnabled = Effect.fn(function* () {
  const code = yield* VsCode;
  const config = yield* Config;

  const managedFeaturesEnabled =
    yield* config.getManagedLanguageFeaturesEnabled();

  if (!managedFeaturesEnabled) {
    yield* Effect.logInfo(
      "Managed language features are disabled. Not starting managed Ruff language server.",
    );
    return Option.some(
      RuffLanguageServerHealth.Failed({
        error: "Managed language features are disabled in marimo settings.",
      }),
    );
  }

  const ruffExtension = code.extensions.getExtension(RUFF_EXTENSION_ID);
  if (Option.isNone(ruffExtension)) {
    yield* Effect.logInfo(
      "Ruff extension is not installed. Not starting managed Ruff language server.",
    );
    return Option.some(
      RuffLanguageServerHealth.Failed({
        error: `Ruff extension (${RUFF_EXTENSION_ID}) is not installed.`,
      }),
    );
  }

  const ruffConfig = yield* code.workspace.getConfiguration("ruff");
  const ruffEnabled = ruffConfig.get<boolean>("enable", true);

  if (!ruffEnabled) {
    yield* Effect.logInfo(
      "Ruff extension is disabled via ruff.enable setting. Not starting managed Ruff language server.",
    );
    return Option.some(
      RuffLanguageServerHealth.Failed({
        error: "Ruff extension is disabled (ruff.enable = false).",
      }),
    );
  }

  return Option.none();
});

/**
 * Checks if Ruff is configured as the default Python formatter in VS Code settings.
 *
 * Ref: https://github.com/astral-sh/ruff-vscode?tab=readme-ov-file#configuring-vs-code
 */
const ruffConfiguredAsDefaultPythonFormatter = Effect.fn(function* () {
  const code = yield* VsCode;
  const pythonConfig = yield* code.workspace.getConfiguration("", {
    languageId: "python",
  });
  return (
    pythonConfig.get<unknown>("editor.defaultFormatter") === RUFF_EXTENSION_ID
  );
});
