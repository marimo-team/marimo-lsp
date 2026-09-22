import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect";

import * as Config from "../config/Config.ts";
import {
  BinarySource,
  companionExtensionBundledBinary,
  companionExtensionConfiguredPath,
  resolveBinary,
  userConfiguredPath,
} from "../lib/binaryResolution.ts";
import { isExpectedCancellation } from "../lib/isExpectedCancellation.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import * as NotebookVariables from "../panel/variables/NotebookVariables.ts";
import * as OutputChannel from "../platform/OutputChannel.ts";
import { createStorageKey, Storage } from "../platform/Storage.ts";
import { VsCode } from "../platform/VsCode.ts";
import * as PythonEnvInvalidation from "../python/PythonEnvInvalidation.ts";
import { PythonExtension } from "../python/PythonExtension.ts";
import { Telemetry } from "../telemetry/Telemetry.ts";
import { connectMarimoNotebookLspClient } from "./connect.ts";

const TY_SERVER = { name: "ty", version: "0.0.63" } as const;
const TY_EXTENSION_ID = "astral-sh.ty";
const INSTALL_TY_EXTENSION = "Install ty Extension";
const SHOW_TY_EXTENSION = "Show ty Extension";
const DONT_SHOW_AGAIN = "Don't Show Again";
const RELOAD_WINDOW = "Reload Window";

/**
 * Remembers that the user dismissed the "install ty" prompt, so we never ask
 * again on this machine. Installing the extension sets it too.
 */
const tyPromptDismissedKey = createStorageKey(
  "languageServer.ty.installPromptDismissed",
  Schema.Boolean,
);

/**
 * No ty binary is available. We never install one ourselves — the user
 * supplies it via the official ty extension or `marimo.ty.path`.
 */
export class BinaryNotFoundError extends Data.TaggedError(
  "TyLanguageServer.BinaryNotFoundError",
)<{
  readonly serverVersion: string;
}> {
  format(): string {
    return [
      `No ty ${this.serverVersion} or newer binary was found.`,
      "Python completions and type diagnostics are unavailable. You can still edit and run notebooks.",
      "To enable these features, install or update the official ty extension (astral-sh.ty) or set marimo.ty.path, then reload VS Code.",
    ].join("\n");
  }
}

export const Status = Data.taggedEnum<Status>();

export type Status = Data.TaggedEnum<{
  Starting: {};
  Disabled: { readonly reason: string };
  NotFound: { readonly message: string };
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
export interface Interface {
  readonly getHealthStatus: Effect.Effect<Status>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/TyLanguageServer",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const pyExt = yield* PythonExtension;
    const envInvalidation = yield* PythonEnvInvalidation.Service;
    const telemetry = yield* Effect.serviceOption(Telemetry);
    const code = yield* VsCode;
    const notifyMissingTy = yield* makeMissingNotifier();

    const statusRef = yield* Ref.make<Status>(Status.Starting());

    const disabledReasonOption = yield* getTyDisabledReason();
    if (Option.isSome(disabledReasonOption)) {
      if (Option.isSome(telemetry)) yield* telemetry.value.tySetup("disabled");
      yield* Ref.set(
        statusRef,
        Status.Disabled({
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
          yield* Ref.set(statusRef, Status.Starting());
          yield* Effect.logDebug("Starting language server").pipe(
            Effect.annotateLogs({
              server: TY_SERVER.name,
              version: TY_SERVER.version,
            }),
          );

          const resolved = yield* Option.match(yield* resolveTyBinary(), {
            onNone: () =>
              new BinaryNotFoundError({ serverVersion: TY_SERVER.version }),
            onSome: Effect.succeed,
          });

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
                  const path = yield* pyExt.getActiveEnvironmentPath(scopeUri);
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
            Status.Running({
              serverVersion,
              binarySource: resolved,
              pythonEnvironment,
            }),
          );

          // Block until env invalidation, then return to let
          // Effect.scoped clean up and the loop restart.
          yield* envInvalidation.changes.pipe(Stream.take(1), Stream.runDrain);

          yield* Effect.logInfo("Restarting language server").pipe(
            Effect.annotateLogs({ server: TY_SERVER.name }),
          );
        }).pipe(Effect.scoped);

        // Run the server in a loop: start → invalidation → restart.
        // A missing binary gets a dedicated recovery path; other failures
        // propagate to catchCause and stop the loop.
        yield* Effect.forever(serverCycle).pipe(
          // A missing binary is a user-resolvable configuration state, not
          // a crash: record it, nudge once, and stop the restart loop.
          Effect.catchTag("TyLanguageServer.BinaryNotFoundError", (error) =>
            Effect.gen(function* () {
              const message = error.format();
              yield* Ref.set(statusRef, Status.NotFound({ message }));
              yield* Effect.logInfo(message).pipe(
                Effect.annotateLogs({
                  server: TY_SERVER.name,
                  version: TY_SERVER.version,
                }),
              );
              if (Option.isSome(telemetry)) {
                yield* telemetry.value.binaryUnresolved("ty");
              }
              yield* notifyMissingTy;
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (isExpectedCancellation(cause)) return;
              if (Option.isSome(telemetry))
                yield* telemetry.value.tySetup("startup_failed");
              const message = "Failed to start ty language server";
              yield* Ref.set(statusRef, Status.Failed({ message, cause }));
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

    return Service.of({
      getHealthStatus: Ref.get(statusRef),
    });
  }),
);

export const defaultLayer = layer.pipe(
  Layer.provide([
    Config.layer,
    OutputChannel.layer,
    NotebookVariables.defaultLayer,
    PythonEnvInvalidation.layer,
    Storage.layer,
  ]),
);

/**
 * Resolves the ty binary using a 2-tier strategy:
 * 1. User-configured path (`marimo.ty.path`)
 * 2. Companion extension discovery — first `ty.path` setting, then bundled binary
 *
 * Returns `Option.none()` when no tier matches. Nothing here touches the
 * network, so a blocked package index or an offline machine can't stall
 * startup.
 */
const resolveTyBinary = Effect.fn(function* () {
  const code = yield* VsCode;
  const config = yield* Config.Service;

  const tyExtension = code.extensions.getExtension(TY_EXTENSION_ID);

  const tyExtConfiguredPath = Effect.gen(function* () {
    const tyExtConfig = yield* code.workspace.getConfiguration("ty");
    return Option.fromNullishOr(tyExtConfig.get<string[]>("path")).pipe(
      Option.filter((p) => p.length > 0),
      Option.map((p) => p[0]),
    );
  });

  const resolved = yield* resolveBinary(TY_SERVER.name, [
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
  ]);

  return resolved;
});

/**
 * Builds the one-shot prompt shown when no ty binary is available.
 *
 * Fires at most once per session (`Effect.cached`) and never again on this
 * machine once the user chooses Don't Show Again. Installing is not dismissal.
 * The local F5 configuration bypasses persistence so reloads can replay it.
 */
export const makeMissingNotifier = Effect.fn(
  "TyLanguageServer.makeMissingNotifier",
)(function* () {
  const code = yield* VsCode;
  const storage = yield* Storage;
  const trackSetup = Option.match(yield* Effect.serviceOption(Telemetry), {
    onSome: (telemetry) => telemetry.tySetup,
    onNone: () => () => Effect.void,
  });
  const persistDismissal = process.env.MARIMO_REPLAY_TY_PROMPT !== "1";

  return yield* Effect.cached(
    Effect.gen(function* () {
      const alreadyInstalled = Option.isSome(
        code.extensions.getExtension(TY_EXTENSION_ID),
      );
      if (persistDismissal) {
        const dismissed = yield* storage.global
          .get(tyPromptDismissedKey)
          .pipe(Effect.orElseSucceed(() => Option.none<boolean>()));
        if (Option.getOrElse(dismissed, () => false)) {
          yield* trackSetup("prompt_suppressed");
          return;
        }
      }

      // An installed-but-too-old ty extension needs an update, not an
      // install, so the prompt has to know which situation it is in.
      const action = alreadyInstalled
        ? SHOW_TY_EXTENSION
        : INSTALL_TY_EXTENSION;

      yield* trackSetup("prompt_shown");
      const selection = yield* code.window.showWarningMessage(
        alreadyInstalled
          ? "Python completions and type diagnostics are unavailable because no compatible ty language server was found. Update the ty extension to enable them. You can still edit and run notebooks."
          : "Python completions and type diagnostics are unavailable because no compatible ty language server was found. Install the recommended ty extension to enable them. You can still edit and run notebooks.",
        { items: [action, DONT_SHOW_AGAIN] },
      );
      if (Option.isNone(selection)) {
        yield* trackSetup("dismiss");
        return;
      }

      const remember = persistDismissal
        ? storage.global.set(tyPromptDismissedKey, true).pipe(Effect.ignore)
        : Effect.void;

      if (selection.value === DONT_SHOW_AGAIN) {
        yield* trackSetup("dont_show_again");
        yield* remember;
        return;
      }

      if (alreadyInstalled) {
        yield* trackSetup("update");
        // The extension view is where the update button lives; leave the
        // prompt un-dismissed so a user who ignores it is reminded later.
        yield* code.commands
          .executeVSCode("extension.open", TY_EXTENSION_ID)
          .pipe(Effect.ignore);
        return;
      }

      yield* trackSetup("install");
      const install = yield* Effect.exit(
        code.commands.executeVSCode(
          "workbench.extensions.installExtension",
          TY_EXTENSION_ID,
        ),
      );
      if (Exit.isFailure(install)) {
        if (isExpectedCancellation(install.cause)) {
          // A never-successful Effect requires return yield* for Effect tooling.
          // oxlint-disable-next-line typescript/consistent-return
          return yield* Effect.failCause(install.cause);
        }
        yield* trackSetup("install_failed");
        yield* Effect.logError("Failed to install the ty extension").pipe(
          Effect.annotateLogs({ cause: install.cause }),
        );
        yield* code.window.showErrorMessage(
          "VS Code couldn't install the ty extension. Search for @id:astral-sh.ty in the Extensions view.",
        );
        return;
      }

      yield* trackSetup("install_succeeded");

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
  const config = yield* Config.Service;

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
