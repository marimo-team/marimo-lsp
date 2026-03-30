import * as NodePath from "node:path";

import { type Cause, Data, Effect, Exit, Option, Ref } from "effect";
import type * as vscode from "vscode";

import {
  BinarySource,
  companionExtensionBundledBinary,
  companionExtensionConfiguredPath,
  resolveBinary,
  userConfiguredPath,
} from "../../utils/binaryResolution.ts";
import { connectMarimoNotebookLspClient } from "../../utils/connectMarimoLspClient.ts";
import { showErrorAndPromptLogs } from "../../utils/showErrorAndPromptLogs.ts";
import { Config } from "../Config.ts";
import { OutputChannel } from "../OutputChannel.ts";
import { Sentry } from "../Sentry.ts";
import { ExtensionContext } from "../Storage.ts";
import { Telemetry } from "../Telemetry.ts";
import { Uv } from "../Uv.ts";
import { VariablesService } from "../variables/VariablesService.ts";
import { VsCode } from "../VsCode.ts";

// Pin Ruff version for stability, matching ruff-vscode's approach.
// Bump this as needed for new features or fixes.
const RUFF_SERVER = { name: "ruff", version: "0.15.8" } as const;
const RUFF_EXTENSION_ID = "charliermarsh.ruff";

export const RuffLanguageServerStatus =
  Data.taggedEnum<RuffLanguageServerStatus>();

type RuffLanguageServerStatus = Data.TaggedEnum<{
  Starting: {};
  Disabled: { readonly reason: string };
  Running: {
    readonly serverVersion: string;
    readonly binarySource: BinarySource;
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
 * Uses NotebookLspClient (custom Effect-based LSP client) instead of
 * vscode-languageclient, giving us full control over notebook cell ordering.
 */
export class RuffLanguageServer extends Effect.Service<RuffLanguageServer>()(
  "RuffLanguageServer",
  {
    dependencies: [
      Uv.Default,
      Config.Default,
      OutputChannel.Default,
      VariablesService.Default,
    ],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const sentry = yield* Effect.serviceOption(Sentry);
      const telemetry = yield* Effect.serviceOption(Telemetry);

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
            return;
          }

          yield* Effect.logInfo("Starting language server").pipe(
            Effect.annotateLogs({
              server: RUFF_SERVER.name,
              version: RUFF_SERVER.version,
            }),
          );

          const resolved = yield* resolveRuffBinary();

          // Build initializationOptions from ruff.* settings
          const ruffConfig = yield* code.workspace.getConfiguration("ruff");
          const workspaceFolders = yield* code.workspace.getWorkspaceFolders();
          const settings = Option.getOrElse(workspaceFolders, () => []).map(
            (folder) => getRuffSettings(ruffConfig, folder),
          );
          const globalSettings = getGlobalRuffSettings(ruffConfig);

          const outputChannel = yield* code.window.createOutputChannel(
            `marimo (${RUFF_SERVER.name})`,
          );
          const clientExit = yield* Effect.exit(
            connectMarimoNotebookLspClient({
              name: RUFF_SERVER.name,
              command: resolved.path,
              args: ["server"],
              outputChannel,
              initializationOptions: { settings, globalSettings },
            }),
          );

          if (!Exit.isSuccess(clientExit)) {
            const cause = clientExit.cause;
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

          const client = clientExit.value;
          const serverVersion = client.serverInfo.version;

          yield* Effect.logInfo("Language server started").pipe(
            Effect.annotateLogs({
              server: RUFF_SERVER.name,
              version: serverVersion,
            }),
          );

          if (Option.isSome(sentry)) {
            yield* sentry.value.setTag("ruff.version", serverVersion);
          }
          if (Option.isSome(telemetry)) {
            yield* telemetry.value.reportBinaryResolved(
              "ruff",
              resolved,
              serverVersion,
            );
          }

          yield* Ref.set(
            statusRef,
            RuffLanguageServerStatus.Running({
              serverVersion,
              binarySource: resolved,
            }),
          );

          // TODO: Restart on ruff.* config changes
        }),
      );

      return {
        getHealthStatus: () => Ref.get(statusRef),
      };
    }),
  },
) {}

/**
 * Resolves the ruff binary path using a 3-tier strategy:
 * 1. User-configured path (`marimo.ruff.path`)
 * 2. Companion extension discovery — first `ruff.path` setting, then bundled binary
 * 3. Fallback to `uv pip install`
 */
const resolveRuffBinary = Effect.fn(function* () {
  const code = yield* VsCode;
  const config = yield* Config;
  const uv = yield* Uv;
  const context = yield* ExtensionContext;

  const ruffExtension = code.extensions.getExtension(RUFF_EXTENSION_ID);

  const ruffExtConfiguredPath = Effect.gen(function* () {
    const ruffExtConfig = yield* code.workspace.getConfiguration("ruff");
    return Option.fromNullable(ruffExtConfig.get<string>("path")).pipe(
      Option.filter((p) => p.length > 0),
    );
  });

  return yield* resolveBinary(
    RUFF_SERVER.name,
    [
      userConfiguredPath("ruff", RUFF_SERVER.version, config.ruff.path),
      companionExtensionConfiguredPath(
        "ruff",
        RUFF_SERVER.version,
        RUFF_EXTENSION_ID,
        ruffExtConfiguredPath,
      ),
      companionExtensionBundledBinary(
        "ruff",
        RUFF_SERVER.version,
        RUFF_EXTENSION_ID,
        ruffExtension,
      ),
    ],
    {
      label: "uv install",
      resolve: Effect.gen(function* () {
        const targetPath = NodePath.resolve(
          context.globalStorageUri.fsPath,
          "libs",
        );
        const binaryPath = yield* uv.ensureLanguageServerBinaryInstalled(
          RUFF_SERVER,
          { targetPath },
        );
        return Option.some(BinarySource.UvInstalled({ path: binaryPath }));
      }),
    },
  );
});

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
