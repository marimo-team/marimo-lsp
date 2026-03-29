import * as NodePath from "node:path";

import { type Cause, Data, Effect, Exit, Option, Ref } from "effect";

import { NOTEBOOK_TYPE } from "../../constants.ts";
import {
  BinarySource,
  companionExtensionBundledBinary,
  companionExtensionConfiguredPath,
  resolveBinary,
  userConfiguredPath,
} from "../../utils/binaryResolution.ts";
import { showErrorAndPromptLogs } from "../../utils/showErrorAndPromptLogs.ts";
import { Config } from "../Config.ts";
import { OutputChannel } from "../OutputChannel.ts";
import { PythonExtension } from "../PythonExtension.ts";
import { Sentry } from "../Sentry.ts";
import { ExtensionContext } from "../Storage.ts";
import { Telemetry } from "../Telemetry.ts";
import { Uv } from "../Uv.ts";
import { VariablesService } from "../variables/VariablesService.ts";
import { VsCode } from "../VsCode.ts";
import { connectNotebookClient } from "./connectNotebookClient.ts";
import {
  makeNotebookLspClient,
  type NotebookLspClient,
} from "./NotebookLspClient.ts";
import { registerLspProviders } from "./registerLspProviders.ts";

const TY_SERVER = { name: "ty", version: "0.0.26" } as const;
const TY_EXTENSION_ID = "astral-sh.ty";

export const TyLanguageServerStatus = Data.taggedEnum<TyLanguageServerStatus>();

type TyLanguageServerStatus = Data.TaggedEnum<{
  Starting: {};
  Disabled: { readonly reason: string };
  Running: {
    readonly client: NotebookLspClient;
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
 * Provides LSP features (completions, hover, definitions, signature help,
 * semantic tokens) for notebook cells.
 *
 * Uses NotebookLspClient (custom Effect-based LSP client) instead of
 * vscode-languageclient, giving us full control over notebook cell ordering.
 */
export class TyLanguageServer extends Effect.Service<TyLanguageServer>()(
  "TyLanguageServer",
  {
    dependencies: [
      Uv.Default,
      Config.Default,
      OutputChannel.Default,
      VariablesService.Default,
    ],
    scoped: Effect.gen(function* () {
      const pyExt = yield* PythonExtension;
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
          if (Option.isSome(disabledReasonOption)) {
            return;
          }

          yield* Effect.logInfo("Starting language server").pipe(
            Effect.annotateLogs({
              server: TY_SERVER.name,
              version: TY_SERVER.version,
            }),
          );

          const resolved = yield* resolveTyBinary();

          const workspaceFolders = yield* code.workspace.getWorkspaceFolders();

          const outputChannel = yield* code.window.createLogOutputChannel(
            `marimo (${TY_SERVER.name})`,
          );
          const clientExit = yield* Effect.exit(
            makeNotebookLspClient({
              name: TY_SERVER.name,
              command: resolved.path,
              args: ["server"],
              notebookType: NOTEBOOK_TYPE,
              outputChannel,
              initializationOptions: {},
              workspaceFolders: Option.getOrElse(
                workspaceFolders,
                () => [],
              ).map((f) => ({
                uri: f.uri.toString(),
                name: f.name,
              })),
              onConfigurationRequest: (params) =>
                Effect.forEach(params.items, (item) =>
                  Effect.gen(function* () {
                    if (item.section !== "ty") return null;

                    const scopeUri = item.scopeUri
                      ? code.Uri.parse(item.scopeUri, true)
                      : undefined;
                    const path =
                      yield* pyExt.getActiveEnvironmentPath(scopeUri);
                    const resolved = yield* pyExt.resolveEnvironment(path);
                    const env = Option.getOrNull(resolved);

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
            }),
          );

          if (!Exit.isSuccess(clientExit)) {
            const cause = clientExit.cause;
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
            yield* Effect.forkScoped(showErrorAndPromptLogs(message));
            return;
          }

          const client = clientExit.value;
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

          const updateRunningStatus = Effect.fn(function* () {
            const activePath = yield* pyExt.getActiveEnvironmentPath();
            const resolvedEnv = yield* pyExt.resolveEnvironment(activePath);
            const pythonEnvironment = Option.map(resolvedEnv, (env) => ({
              path: env.executable.uri?.fsPath ?? env.path ?? "Unknown",
              version: env.version?.sysVersion ?? null,
            }));
            yield* Ref.set(
              statusRef,
              TyLanguageServerStatus.Running({
                client,
                serverVersion,
                binarySource: resolved,
                pythonEnvironment,
              }),
            );
          });

          // Wire up VS Code events, diagnostics, and feature providers
          yield* connectNotebookClient(client);
          yield* registerLspProviders(client);

          // TODO: Restart on Python environment changes (debounced 2s)

          yield* updateRunningStatus();
        }),
      );

      return {
        getHealthStatus: () => Ref.get(statusRef),
        restart: Effect.fn(function* (_reason: string) {
          // TODO: Implement restart using NotebookLspClient
          yield* Effect.logWarning(
            "ty restart not yet implemented with NotebookLspClient",
          );
        }),
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
          { targetPath },
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
