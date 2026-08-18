import * as NodePath from "node:path";

import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Stream,
} from "effect";

import { Config } from "../config/Config.ts";
import {
  BinarySource,
  companionExtensionBundledBinary,
  companionExtensionConfiguredPath,
  resolveBinary,
  userConfiguredPath,
  validateBinary,
} from "../lib/binaryResolution.ts";
import { getExtensionVersion } from "../lib/getExtensionVersion.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { NotebookVariables } from "../panel/variables/NotebookVariables.ts";
import { OutputChannel } from "../platform/OutputChannel.ts";
import { ExtensionContext, Storage } from "../platform/Storage.ts";
import { VsCode } from "../platform/VsCode.ts";
import { PythonEnvInvalidation } from "../python/PythonEnvInvalidation.ts";
import { PythonExtension } from "../python/PythonExtension.ts";
import { resolvePlatformBinaryName, Uv } from "../python/Uv.ts";
import { Telemetry } from "../telemetry/Telemetry.ts";
import { connectMarimoNotebookLspClient } from "./connect.ts";
import {
  clearManagedInstallFailure,
  getManagedInstallFailure,
  matchesManagedInstallFailure,
  setManagedInstallFailure,
} from "./managedInstallFailure.ts";

const TY_SERVER = { name: "ty", version: "0.0.63" } as const;
const TY_EXTENSION_ID = "astral-sh.ty";
const INSTALL_TY_EXTENSION = "Install ty Extension";
const OPEN_UV_LOGS = "Open uv Logs";
const RELOAD_WINDOW = "Reload Window";

export class ManagedTyInstallPreviouslyFailed extends Data.TaggedError(
  "ManagedTyInstallPreviouslyFailed",
)<{
  readonly extensionVersion: string;
  readonly serverVersion: string;
  readonly details: string;
}> {
  format(): string {
    return [
      this.details,
      "Managed installation will be retried after the marimo extension is updated.",
      "To recover now, install the official ty extension (astral-sh.ty) or configure marimo.ty.path, then reload VS Code.",
      "For full installation output, open the marimo (uv) output channel.",
    ].join("\n");
  }
}

export const TyLanguageServerStatus = Data.taggedEnum<TyLanguageServerStatus>();

type TyLanguageServerStatus = Data.TaggedEnum<{
  Starting: {};
  Disabled: { readonly reason: string };
  Running: {
    readonly serverVersion: string;
    readonly binarySource: BinarySource;
    readonly pythonEnvironment: Option.Option<{
      path: string;
      version: string | null;
    }>;
  };
  Failed: {
    readonly message: string;
    readonly cause?: Cause.Cause<unknown>;
  };
}>;

/**
 * Manages a dedicated ty language server instance for marimo notebooks.
 *
 * The server is restarted when the Python environment changes, matching
 * the official ty-vscode extension behavior (ty doesn't support
 * `workspace/didChangeConfiguration` — a full restart is required).
 */
export class TyLanguageServer extends Context.Service<TyLanguageServer>()(
  "TyLanguageServer",
  {
    make: Effect.gen(function* () {
      const pyExt = yield* PythonExtension;
      const envInvalidation = yield* PythonEnvInvalidation;
      const telemetry = yield* Effect.serviceOption(Telemetry);
      const code = yield* VsCode;
      const uv = yield* Uv;
      const notifyInstallFailure = yield* makeTyInstallFailureNotifier(
        uv.channel,
      );

      const statusRef = yield* Ref.make<TyLanguageServerStatus>(
        TyLanguageServerStatus.Starting(),
      );

      const disabledReasonOption = yield* getTyDisabledReason();
      if (Option.isSome(disabledReasonOption)) {
        yield* Ref.set(
          statusRef,
          TyLanguageServerStatus.Disabled({
            reason: disabledReasonOption.value,
          }),
        );
      }

      yield* Effect.forkScoped(
        Effect.gen(function* () {
          if (Option.isSome(disabledReasonOption)) return;

          const outputChannel = yield* code.window.createOutputChannel(
            `marimo (${TY_SERVER.name})`,
          );

          // One server cycle: start → run → wait for env change → return.
          // The Effect.scoped wrapper ensures the server process and all
          // resources are cleaned up before the next cycle begins.
          const serverCycle = Effect.gen(function* () {
            yield* Ref.set(statusRef, TyLanguageServerStatus.Starting());
            yield* Effect.logDebug("Starting language server").pipe(
              Effect.annotateLogs({
                server: TY_SERVER.name,
                version: TY_SERVER.version,
              }),
            );

            const resolved = yield* resolveTyBinary();

            const client = yield* connectMarimoNotebookLspClient({
              name: TY_SERVER.name,
              command: resolved.path,
              args: ["server"],
              outputChannel,
              initializationOptions: {},
              onConfigurationRequest: (params) =>
                Effect.forEach(params.items, (item) =>
                  Effect.gen(function* () {
                    if (item.section !== "ty") return null;

                    const scopeUri = item.scopeUri
                      ? code.Uri.parse(item.scopeUri, true)
                      : undefined;
                    const path =
                      yield* pyExt.getActiveEnvironmentPath(scopeUri);
                    const env = Option.getOrNull(
                      yield* pyExt.resolveEnvironment(path),
                    );

                    return {
                      pythonExtension: {
                        activeEnvironment:
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
                              },
                      },
                    };
                  }),
                ),
            });

            const serverVersion = client.serverInfo.version;

            yield* Effect.logInfo("Language server started").pipe(
              Effect.annotateLogs({
                server: TY_SERVER.name,
                version: serverVersion,
              }),
            );

            if (Option.isSome(telemetry)) {
              yield* telemetry.value.binaryResolved({
                server: "ty",
                resolved,
                version: serverVersion,
              });
            }

            // Update running status with current Python environment
            const activePath = yield* pyExt.getActiveEnvironmentPath();
            const resolvedEnv = yield* pyExt.resolveEnvironment(activePath);
            const pythonEnvironment = Option.map(resolvedEnv, (env) => ({
              path: env.executable.uri?.fsPath ?? env.path ?? "Unknown",
              version: env.version?.sysVersion ?? null,
            }));
            yield* Ref.set(
              statusRef,
              TyLanguageServerStatus.Running({
                serverVersion,
                binarySource: resolved,
                pythonEnvironment,
              }),
            );

            // Block until env invalidation, then return to let
            // Effect.scoped clean up and the loop restart.
            yield* envInvalidation.changes.pipe(
              Stream.take(1),
              Stream.runDrain,
            );

            yield* Effect.logInfo("Restarting language server").pipe(
              Effect.annotateLogs({ server: TY_SERVER.name }),
            );
          }).pipe(Effect.scoped);

          // Run the server in a loop: start → invalidation → restart.
          // Installation failures get a dedicated recovery path; other
          // failures propagate to catchCause and stop the loop.
          yield* Effect.forever(serverCycle).pipe(
            Effect.catchTag("ManagedTyInstallPreviouslyFailed", (error) =>
              Effect.gen(function* () {
                const message = error.format();
                yield* Ref.set(
                  statusRef,
                  TyLanguageServerStatus.Failed({
                    message,
                    cause: Cause.fail(error),
                  }),
                );
                yield* Effect.logWarning(message).pipe(
                  Effect.annotateLogs({
                    server: TY_SERVER.name,
                    version: TY_SERVER.version,
                  }),
                );
              }),
            ),
            Effect.catchTag("LanguageServerInstallError", (error) =>
              Effect.gen(function* () {
                const message = error.message;
                yield* Ref.set(
                  statusRef,
                  TyLanguageServerStatus.Failed({
                    message,
                    cause: Cause.fail(error),
                  }),
                );
                yield* Effect.logError(message).pipe(
                  Effect.annotateLogs({
                    server: TY_SERVER.name,
                    version: TY_SERVER.version,
                  }),
                );
                yield* notifyInstallFailure;
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                if (Cause.hasInterruptsOnly(cause)) return;
                const message = "Failed to start ty language server";
                yield* Ref.set(
                  statusRef,
                  TyLanguageServerStatus.Failed({ message, cause }),
                );
                yield* Effect.logError(message).pipe(
                  Effect.annotateLogs({
                    server: TY_SERVER.name,
                    version: TY_SERVER.version,
                    cause,
                  }),
                );
                yield* showErrorAndPromptLogs(message);
              }),
            ),
          );
        }),
      );

      return {
        getHealthStatus: Ref.get(statusRef),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([
      Uv.layer,
      Config.layer,
      OutputChannel.layer,
      NotebookVariables.layer,
      PythonEnvInvalidation.layer,
      Storage.layer,
    ]),
  );
}

/**
 * Resolves the ty binary path using a 3-tier strategy:
 * 1. User-configured path (`marimo.ty.path`)
 * 2. Companion extension discovery — first `ty.path` setting, then bundled binary
 * 3. Fallback to `uv pip install`
 */
const resolveTyBinary = Effect.fn(function* () {
  const code = yield* VsCode;
  const config = yield* Config;
  const uv = yield* Uv;
  const context = yield* ExtensionContext;
  const extensionVersion = yield* getExtensionVersion();

  const tyExtension = code.extensions.getExtension(TY_EXTENSION_ID);
  const targetPath = NodePath.resolve(context.globalStorageUri.fsPath, "libs");
  const managedBinaryPath = NodePath.resolve(
    targetPath,
    "bin",
    resolvePlatformBinaryName(TY_SERVER.name),
  );

  const tyExtConfiguredPath = Effect.gen(function* () {
    const tyExtConfig = yield* code.workspace.getConfiguration("ty");
    return Option.fromNullishOr(tyExtConfig.get<string[]>("path")).pipe(
      Option.filter((p) => p.length > 0),
      Option.map((p) => p[0]),
    );
  });

  const resolved = yield* resolveBinary(
    TY_SERVER.name,
    [
      userConfiguredPath("ty", TY_SERVER.version, config.ty.path),
      companionExtensionConfiguredPath(
        "ty",
        TY_SERVER.version,
        TY_EXTENSION_ID,
        tyExtConfiguredPath,
      ),
      companionExtensionBundledBinary(
        "ty",
        TY_SERVER.version,
        TY_EXTENSION_ID,
        tyExtension,
      ),
      {
        label: "existing managed installation",
        resolve: validateBinary(managedBinaryPath, TY_SERVER.version).pipe(
          Effect.map(Option.map((path) => BinarySource.UvInstalled({ path }))),
        ),
      },
    ],
    {
      label: "uv install",
      resolve: Effect.gen(function* () {
        const previousFailure =
          yield* getPreviousInstallFailure(extensionVersion);
        if (Option.isSome(previousFailure)) {
          return yield* new ManagedTyInstallPreviouslyFailed({
            extensionVersion: previousFailure.value.extensionVersion,
            serverVersion: previousFailure.value.serverVersion,
            details: previousFailure.value.details,
          });
        }

        const binaryPath = yield* uv
          .ensureLanguageServerBinaryInstalled(TY_SERVER, { targetPath })
          .pipe(
            Effect.tapError((error) =>
              rememberInstallFailure(extensionVersion, error.message),
            ),
          );
        return Option.some(BinarySource.UvInstalled({ path: binaryPath }));
      }),
    },
  );

  yield* clearManagedInstallFailure(TY_SERVER.name).pipe(Effect.ignore);
  return resolved;
});

const getPreviousInstallFailure = Effect.fn(function* (
  extensionVersion: Option.Option<string>,
) {
  if (Option.isNone(extensionVersion)) return Option.none();

  const failure = yield* getManagedInstallFailure(TY_SERVER.name).pipe(
    Effect.orElseSucceed(() => Option.none()),
  );
  return matchesManagedInstallFailure(failure, {
    extensionVersion: extensionVersion.value,
    serverVersion: TY_SERVER.version,
  })
    ? failure
    : Option.none();
});

const rememberInstallFailure = Effect.fn(function* (
  extensionVersion: Option.Option<string>,
  details: string,
) {
  if (Option.isNone(extensionVersion)) return;

  yield* setManagedInstallFailure(TY_SERVER.name, {
    extensionVersion: extensionVersion.value,
    serverVersion: TY_SERVER.version,
    details,
  }).pipe(Effect.ignore);
});

export const makeTyInstallFailureNotifier = Effect.fn(
  "TyLanguageServer.makeTyInstallFailureNotifier",
)(function* (channel: { readonly name: string; show(): void }) {
  const code = yield* VsCode;

  return yield* Effect.cached(
    Effect.gen(function* () {
      const selection = yield* code.window.showWarningMessage(
        "marimo couldn't install ty. Install the official ty extension to enable Python completions and diagnostics in marimo notebooks.",
        { items: [INSTALL_TY_EXTENSION, OPEN_UV_LOGS] },
      );
      if (Option.isNone(selection)) return;

      if (selection.value === OPEN_UV_LOGS) {
        channel.show();
        return;
      }

      const install = yield* Effect.exit(
        code.commands.executeVSCode(
          "workbench.extensions.installExtension",
          TY_EXTENSION_ID,
        ),
      );
      if (Exit.isFailure(install)) {
        yield* Effect.logError("Failed to install the ty extension").pipe(
          Effect.annotateLogs({ cause: install.cause }),
        );
        yield* code.window.showErrorMessage(
          "VS Code couldn't install the ty extension. Search for @id:astral-sh.ty in the Extensions view.",
        );
        return;
      }

      const reload = yield* code.window.showInformationMessage(
        "Reload VS Code to finish enabling the ty extension in marimo notebooks.",
        { items: [RELOAD_WINDOW] },
      );
      if (Option.contains(reload, RELOAD_WINDOW)) {
        yield* code.commands.executeVSCode("workbench.action.reloadWindow");
      }
    }),
  );
});

/**
 * Checks if the managed ty language server should be enabled.
 */
const getTyDisabledReason = Effect.fn(function* () {
  const config = yield* Config;

  const managedFeaturesEnabled =
    yield* config.getManagedLanguageFeaturesEnabled;

  if (!managedFeaturesEnabled) {
    yield* Effect.logInfo(
      "Managed language features are disabled. Not starting managed ty language server.",
    );
    return Option.some(
      "Managed language features are disabled in marimo settings.",
    );
  }

  return Option.none();
});
