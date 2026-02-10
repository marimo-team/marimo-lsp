import type * as vscode from "vscode";
import type * as lsp from "vscode-languageclient/node";

import {
  type Cause,
  Data,
  Effect,
  Exit,
  Option,
  Ref,
  Runtime,
  Stream,
} from "effect";

import {
  createManagedLanguageClient,
  type ManagedLanguageClient,
} from "../../utils/createManagedLanguageClient.ts";
import { showErrorAndPromptLogs } from "../../utils/showErrorAndPromptLogs.ts";
import { Config } from "../Config.ts";
import { OutputChannel } from "../OutputChannel.ts";
import { Sentry } from "../Sentry.ts";
import { Uv } from "../Uv.ts";
import { VariablesService } from "../variables/VariablesService.ts";
import { VsCode } from "../VsCode.ts";
import {
  type ClientNotebookSync,
  NotebookSyncService,
} from "./NotebookSyncService.ts";

// Pin Ruff version for stability, matching ruff-vscode's approach.
// Bump this as needed for new features or fixes.
const RUFF_SERVER = { name: "ruff", version: "0.15.0" } as const;
const RUFF_EXTENSION_ID = "charliermarsh.ruff";

export const RuffLanguageServerStatus =
  Data.taggedEnum<RuffLanguageServerStatus>();

type RuffLanguageServerStatus = Data.TaggedEnum<{
  // biome-ignore lint/complexity/noBannedTypes: This is ok with Effect enums
  Starting: {};
  Disabled: { readonly reason: string };
  Running: {
    readonly client: ManagedLanguageClient;
    readonly serverVersion: string;
  };
  Failed: {
    readonly message: string;
    readonly cause?: Cause.Cause<unknown>;
  };
}>;

/**
 * Manages a dedicated Ruff language server instance for marimo notebooks.
 * Provides linting diagnostics for notebook cells.
 *
 * Ruff has native notebook support. We configure automatic notebook sync
 * and use middleware to map mo-python -> python language IDs.
 */
export class RuffLanguageServer extends Effect.Service<RuffLanguageServer>()(
  "RuffLanguageServer",
  {
    dependencies: [
      Uv.Default,
      Config.Default,
      VariablesService.Default,
      NotebookSyncService.Default,
      OutputChannel.Default,
    ],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const sync = yield* NotebookSyncService;
      const sentry = yield* Effect.serviceOption(Sentry);

      const statusRef = yield* Ref.make<RuffLanguageServerStatus>(
        RuffLanguageServerStatus.Starting(),
      );

      const disabledReasonOption = yield* getRuffDisabledReason();
      if (Option.isSome(disabledReasonOption)) {
        yield* Ref.set(
          statusRef,
          RuffLanguageServerStatus.Disabled({
            reason: disabledReasonOption.value,
          }),
        );
      }

      yield* Effect.forkScoped(
        Effect.gen(function* () {
          if (Option.isSome(disabledReasonOption)) {
            // Skip startup completely if disabled for any reason
            return;
          }

          // Phase 1: Install the language server
          yield* Effect.logInfo("Starting language server").pipe(
            Effect.annotateLogs({
              server: RUFF_SERVER.name,
              version: RUFF_SERVER.version,
            }),
          );

          // Create isolated sync instance with its own cell count tracking.
          const notebookSync = yield* sync.forClient();

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

          const installExit = yield* Effect.exit(
            createManagedLanguageClient(RUFF_SERVER, {
              notebookSync,
              clientOptions: {
                outputChannelName: "marimo (ruff)",
                middleware: yield* createRuffMiddleware(notebookSync),
                documentSelector: sync.getDocumentSelector(),
                transformServerCapabilities: sync.extendNotebookCellLanguages(),
                initializationOptions: { settings, globalSettings },
              },
            }),
          );

          if (!Exit.isSuccess(installExit)) {
            const cause = installExit.cause;
            const message = "Failed to install language server";
            yield* Ref.set(
              statusRef,
              RuffLanguageServerStatus.Failed({ message, cause }),
            );
            yield* Effect.logError(message).pipe(
              Effect.annotateLogs({
                server: RUFF_SERVER.name,
                version: RUFF_SERVER.version,
                cause,
              }),
            );
            yield* Effect.forkScoped(showErrorAndPromptLogs(message));
            return;
          }

          // Phase 2: Start the server
          const client = installExit.value;
          yield* Effect.forkScoped(
            Effect.gen(function* () {
              const startExit = yield* Effect.exit(client.start());

              if (!Exit.isSuccess(startExit)) {
                const cause = startExit.cause;
                const message = "Failed to start language server";
                yield* Ref.set(
                  statusRef,
                  RuffLanguageServerStatus.Failed({ message, cause }),
                );
                yield* Effect.logError(message).pipe(
                  Effect.annotateLogs({
                    server: RUFF_SERVER.name,
                    version: RUFF_SERVER.version,
                    cause,
                  }),
                );
                yield* Effect.forkScoped(showErrorAndPromptLogs(message));
                return;
              }

              const serverVersion = startExit.value.pipe(
                Option.map((info) => info.version),
                Option.getOrElse(() => "unknown"),
              );

              yield* Effect.logInfo("Language server started").pipe(
                Effect.annotateLogs({
                  server: RUFF_SERVER.name,
                  version: serverVersion,
                }),
              );

              if (Option.isSome(sentry)) {
                yield* sentry.value.setTag("ruff.version", serverVersion);
              }

              yield* Ref.set(
                statusRef,
                RuffLanguageServerStatus.Running({ client, serverVersion }),
              );

              // Restart the language server when ruff.* settings change
              yield* Effect.forkScoped(
                code.workspace.configurationChanges().pipe(
                  Stream.filter((event) => event.affectsConfiguration("ruff")),
                  Stream.runForEach(() =>
                    client.restart("Ruff settings changed").pipe(
                      Effect.catchAllCause((cause) =>
                        Effect.logError(
                          "Failed to restart language server",
                        ).pipe(
                          Effect.annotateLogs({
                            server: RUFF_SERVER.name,
                            cause,
                          }),
                        ),
                      ),
                    ),
                  ),
                ),
              );
            }),
          );
        }),
      );

      return {
        getHealthStatus: () => Ref.get(statusRef),
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
 * Uses the provided notebook middleware for base notebook handling,
 * and adds Ruff-specific formatting and code action middleware.
 */
function createRuffMiddleware(
  sync: ClientNotebookSync,
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
      notebooks: sync.notebookMiddleware,
      didOpen: (doc, next) => next(sync.adapter.document(doc)),
      didClose: (doc, next) => next(sync.adapter.document(doc)),
      didChange: (change, next) =>
        next({ ...change, document: sync.adapter.document(change.document) }),
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
 * Returns the reason why the Ruff language server is disabled, or None if enabled.
 */
const getRuffDisabledReason = Effect.fn(function* () {
  const code = yield* VsCode;
  const config = yield* Config;

  const managedFeaturesEnabled =
    yield* config.getManagedLanguageFeaturesEnabled();

  if (!managedFeaturesEnabled) {
    yield* Effect.logInfo(
      "Managed language features are disabled. Not starting managed Ruff language server.",
    );
    return Option.some(
      "Managed language features are disabled in marimo settings.",
    );
  }

  const ruffExtension = code.extensions.getExtension(RUFF_EXTENSION_ID);
  if (Option.isNone(ruffExtension)) {
    yield* Effect.logInfo(
      "Ruff extension is not installed. Not starting managed Ruff language server.",
    );
    return Option.some(
      `Ruff extension (${RUFF_EXTENSION_ID}) is not installed.`,
    );
  }

  const ruffConfig = yield* code.workspace.getConfiguration("ruff");
  const ruffEnabled = ruffConfig.get<boolean>("enable", true);

  if (!ruffEnabled) {
    yield* Effect.logInfo(
      "Ruff extension is disabled via ruff.enable setting. Not starting managed Ruff language server.",
    );
    return Option.some("Ruff extension is disabled (ruff.enable = false).");
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
