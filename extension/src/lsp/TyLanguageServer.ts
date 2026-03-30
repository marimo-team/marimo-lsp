import * as NodePath from "node:path";

import { type Cause, Data, Effect, Option, Ref, Stream } from "effect";

import { Config } from "../config/Config.ts";
import {
  BinarySource,
  companionExtensionBundledBinary,
  companionExtensionConfiguredPath,
  resolveBinary,
  userConfiguredPath,
} from "../lib/binaryResolution.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { VariablesService } from "../panel/variables/VariablesService.ts";
import { OutputChannel } from "../platform/OutputChannel.ts";
import { ExtensionContext } from "../platform/Storage.ts";
import { VsCode } from "../platform/VsCode.ts";
import { PythonEnvInvalidation } from "../python/PythonEnvInvalidation.ts";
import { PythonExtension } from "../python/PythonExtension.ts";
import { Uv } from "../python/Uv.ts";
import { Sentry } from "../telemetry/Sentry.ts";
import { Telemetry } from "../telemetry/Telemetry.ts";
import { connectMarimoNotebookLspClient } from "./connect.ts";

const TY_SERVER = { name: "ty", version: "0.0.26" } as const;
const TY_EXTENSION_ID = "astral-sh.ty";

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
export class TyLanguageServer extends Effect.Service<TyLanguageServer>()(
  "TyLanguageServer",
  {
    dependencies: [
      Uv.Default,
      Config.Default,
      OutputChannel.Default,
      VariablesService.Default,
      PythonEnvInvalidation.Default,
    ],
    scoped: Effect.gen(function* () {
      const pyExt = yield* PythonExtension;
      const envInvalidation = yield* PythonEnvInvalidation;
      const sentry = yield* Effect.serviceOption(Sentry);
      const telemetry = yield* Effect.serviceOption(Telemetry);
      const code = yield* VsCode;

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
            yield* Effect.logInfo("Starting language server").pipe(
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

            if (Option.isSome(sentry)) {
              yield* sentry.value.setTag("ty.version", serverVersion);
            }
            if (Option.isSome(telemetry)) {
              yield* telemetry.value.reportBinaryResolved(
                "ty",
                resolved,
                serverVersion,
              );
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
            yield* envInvalidation
              .changes()
              .pipe(Stream.take(1), Stream.runDrain);

            yield* Effect.logInfo("Restarting language server").pipe(
              Effect.annotateLogs({ server: TY_SERVER.name }),
            );
          }).pipe(Effect.scoped);

          // Run the server in a loop: start → invalidation → restart.
          // On failure, the error propagates to catchAllCause and stops.
          yield* Effect.forever(serverCycle).pipe(
            Effect.catchAllCause((cause) =>
              Effect.gen(function* () {
                const message = "Failed to start language server";
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
        getHealthStatus: () => Ref.get(statusRef),
      };
    }),
  },
) {}

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

  const tyExtension = code.extensions.getExtension(TY_EXTENSION_ID);

  const tyExtConfiguredPath = Effect.gen(function* () {
    const tyExtConfig = yield* code.workspace.getConfiguration("ty");
    return Option.fromNullable(tyExtConfig.get<string[]>("path")).pipe(
      Option.filter((p) => p.length > 0),
      Option.map((p) => p[0]),
    );
  });

  return yield* resolveBinary(
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
    ],
    {
      label: "uv install",
      resolve: Effect.gen(function* () {
        const targetPath = NodePath.resolve(
          context.globalStorageUri.fsPath,
          "libs",
        );
        const binaryPath = yield* uv.ensureLanguageServerBinaryInstalled(
          TY_SERVER,
          {
            targetPath,
          },
        );
        return Option.some(BinarySource.UvInstalled({ path: binaryPath }));
      }),
    },
  );
});

/**
 * Checks if the managed ty language server should be enabled.
 */
const getTyDisabledReason = Effect.fn(function* () {
  const config = yield* Config;

  const managedFeaturesEnabled =
    yield* config.getManagedLanguageFeaturesEnabled();

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
