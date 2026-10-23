import type * as py from "@vscode/python-extension";
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
  Scope,
  Stream,
} from "effect";
import type * as vscode from "vscode";
import type * as lsp from "vscode-languageserver-protocol";

import * as Config from "../config/Config.ts";
import {
  BinarySource,
  type ServerBinary,
  resolveServerBinary,
} from "../lib/binaryResolution.ts";
import { isExpectedCancellation } from "../lib/isExpectedCancellation.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import * as NotebookVariables from "../panel/variables/NotebookVariables.ts";
import * as OutputChannel from "../platform/OutputChannel.ts";
import * as Storage from "../platform/Storage.ts";
import * as VsCode from "../platform/VsCode.ts";
import * as PythonEnvInvalidation from "../python/PythonEnvInvalidation.ts";
import * as PythonExtension from "../python/PythonExtension.ts";
import * as Telemetry from "../telemetry/Telemetry.ts";
import { connectMarimoNotebookLspClient } from "./connect.ts";

const TY_MINIMUM_VERSION = "0.0.63";
const TY_EXTENSION_ID = "astral-sh.ty";
const PYREFLY_MINIMUM_VERSION = "1.0.0";
const PYREFLY_EXTENSION_ID = "meta.pyrefly";
const INSTALL_TY_EXTENSION = "Install ty Extension";
const SHOW_TY_EXTENSION = "Show ty Extension";
const DONT_SHOW_AGAIN = "Don't Show Again";
const RELOAD_WINDOW = "Reload Window";

export type ServerName = "ty" | "pyrefly";

/**
 * Remembers that the user dismissed the "install ty" prompt, so we never ask
 * again on this machine. Installing the extension sets it too.
 */
const tyPromptDismissedKey = Storage.createStorageKey(
  "languageServer.ty.installPromptDismissed",
  Schema.Boolean,
);

/**
 * Neither a ty nor a Pyrefly binary is available. We never install one
 * ourselves — the user supplies it via the official extensions or the
 * `marimo.ty.path` / `marimo.pyrefly.path` settings.
 */
export class BinaryNotFoundError extends Data.TaggedError(
  "PythonLanguageServer.BinaryNotFoundError",
)<{
  readonly tyVersion: string;
  readonly pyreflyVersion: string;
}> {
  format(): string {
    return [
      `No compatible binary was found for ty (${this.tyVersion} or newer) or Pyrefly (${this.pyreflyVersion} or newer).`,
      "Python completions and type diagnostics are unavailable. You can still edit and run notebooks.",
      "To enable these features, install or update the official ty extension (astral-sh.ty) or Pyrefly extension (meta.pyrefly), or set marimo.ty.path or marimo.pyrefly.path, then reload VS Code.",
    ].join("\n");
  }
}

export const Status = Data.taggedEnum<Status>();

export type Status = Data.TaggedEnum<{
  Starting: {};
  Disabled: { readonly reason: string };
  NotFound: { readonly message: string };
  Running: {
    readonly server: ServerName;
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
 * What differs between the Python language servers marimo can manage.
 */
interface ServerSpec extends ServerBinary {
  readonly name: ServerName;
  readonly args: string[];
  /** The `workspace/configuration` section the server asks for. */
  readonly configurationSection: string;
  /** Builds the response for that section from the active environment. */
  readonly configuration: (
    env: py.ResolvedEnvironment | null,
    scopeUri: vscode.Uri | undefined,
  ) => Effect.Effect<unknown, never, VsCode.Service>;
  /**
   * Settings sections that are only read when the server starts, so a change
   * to any of them restarts it.
   */
  readonly restartOnSettingsChange: ReadonlyArray<string>;
}

/**
 * Manages a dedicated Python language server instance for marimo notebooks.
 *
 * ty is preferred. When no ty binary is found, Pyrefly is used if its binary
 * is found. When neither is found, the user is asked to install ty.
 *
 * The server is restarted when the Python environment changes, matching
 * the official ty-vscode extension behavior (ty doesn't support
 * `workspace/didChangeConfiguration` — a full restart is required). Pyrefly
 * is also restarted when the settings it is sent change.
 */
export interface Interface {
  readonly getHealthStatus: Effect.Effect<Status>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/PythonLanguageServer",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const pyExt = yield* PythonExtension.Service;
    const envInvalidation = yield* PythonEnvInvalidation.Service;
    const telemetry = yield* Effect.serviceOption(Telemetry.Service);
    const code = yield* VsCode.Service;
    const notifyMissingServer = yield* makeMissingNotifier();

    const statusRef = yield* Ref.make<Status>(Status.Starting());
    const currentServer = yield* Ref.make(Option.none<ServerName>());

    // Created on first use so that only the selected server gets a channel,
    // and kept for the whole layer so that restarts reuse it.
    const layerScope = yield* Scope.Scope;
    const makeOutputChannel = (name: ServerName) =>
      Effect.cached(
        code.window
          .createOutputChannel(`marimo (${name})`)
          .pipe(Scope.provide(layerScope)),
      );
    const outputChannels = {
      ty: yield* makeOutputChannel("ty"),
      pyrefly: yield* makeOutputChannel("pyrefly"),
    };

    const disabledReasonOption = yield* getDisabledReason();
    if (Option.isSome(disabledReasonOption)) {
      if (Option.isSome(telemetry)) yield* telemetry.value.tySetup("disabled");
      yield* Ref.set(
        statusRef,
        Status.Disabled({
          reason: disabledReasonOption.value,
        }),
      );
    }

    const onConfigurationRequest =
      (spec: ServerSpec) => (params: lsp.ConfigurationParams) =>
        Effect.forEach(params.items, (item) =>
          Effect.gen(function* () {
            if (item.section !== spec.configurationSection) return null;

            const scopeUri = item.scopeUri
              ? code.Uri.parse(item.scopeUri, true)
              : undefined;
            const path = yield* pyExt.getActiveEnvironmentPath(scopeUri);
            const env = Option.getOrNull(yield* pyExt.resolveEnvironment(path));
            return yield* spec.configuration(env, scopeUri);
          }),
        ).pipe(Effect.provideService(VsCode.Service, code));

    yield* Effect.forkScoped(
      Effect.gen(function* () {
        if (Option.isSome(disabledReasonOption)) return;

        // One server cycle: start → run → wait for env change → return.
        // The Effect.scoped wrapper ensures the server process and all
        // resources are cleaned up before the next cycle begins.
        const serverCycle = Effect.gen(function* () {
          yield* Ref.set(statusRef, Status.Starting());

          const { spec, resolved } = yield* Option.match(
            yield* selectServer(),
            {
              onNone: () =>
                new BinaryNotFoundError({
                  tyVersion: TY_MINIMUM_VERSION,
                  pyreflyVersion: PYREFLY_MINIMUM_VERSION,
                }),
              onSome: Effect.succeed,
            },
          );
          yield* Ref.set(currentServer, Option.some(spec.name));
          yield* Effect.logDebug("Starting language server").pipe(
            Effect.annotateLogs({ server: spec.name, path: resolved.path }),
          );

          const client = yield* connectMarimoNotebookLspClient({
            name: spec.name,
            command: resolved.path,
            args: spec.args,
            outputChannel: yield* outputChannels[spec.name],
            initializationOptions: {},
            onConfigurationRequest: onConfigurationRequest(spec),
          });

          const serverVersion = client.serverInfo.version;

          yield* Effect.logInfo("Language server started").pipe(
            Effect.annotateLogs({ server: spec.name, version: serverVersion }),
          );

          if (Option.isSome(telemetry)) {
            yield* telemetry.value.binaryResolved({
              server: spec.name,
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
              server: spec.name,
              serverVersion,
              binarySource: resolved,
              pythonEnvironment,
            }),
          );

          // Block until env invalidation or a settings change, then return to
          // let Effect.scoped clean up and the loop restart.
          const settingsChanges = code.workspace.configurationChanges.pipe(
            Stream.filter((event) =>
              spec.restartOnSettingsChange.some((section) =>
                event.affectsConfiguration(section),
              ),
            ),
          );
          yield* Stream.merge(envInvalidation.changes, settingsChanges).pipe(
            Stream.take(1),
            Stream.runDrain,
          );

          yield* Effect.logInfo("Restarting language server").pipe(
            Effect.annotateLogs({ server: spec.name }),
          );
        }).pipe(Effect.scoped);

        // Run the server in a loop: start → invalidation → restart.
        // A missing binary gets a dedicated recovery path; other failures
        // propagate to catchCause and stop the loop.
        yield* Effect.forever(serverCycle).pipe(
          // A missing binary is a user-resolvable configuration state, not
          // a crash: record it, nudge once, and stop the restart loop.
          Effect.catchTag("PythonLanguageServer.BinaryNotFoundError", (error) =>
            Effect.gen(function* () {
              const message = error.format();
              yield* Ref.set(statusRef, Status.NotFound({ message }));
              yield* Effect.logInfo(message);
              if (Option.isSome(telemetry)) {
                yield* telemetry.value.binaryUnresolved("ty");
              }
              yield* notifyMissingServer;
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (isExpectedCancellation(cause)) return;
              const server = Option.getOrElse(
                yield* Ref.get(currentServer),
                () => "Python",
              );
              if (Option.isSome(telemetry) && server === "ty")
                yield* telemetry.value.tySetup("startup_failed");
              const message = `Failed to start ${server} language server`;
              yield* Ref.set(statusRef, Status.Failed({ message, cause }));
              yield* Effect.logError(message).pipe(
                Effect.annotateLogs({ server, cause }),
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
 * ty asks for the `ty` section and reads the active environment in the shape
 * the ty extension sends.
 */
const tyConfiguration = (env: py.ResolvedEnvironment | null) => ({
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
                    folderUri: env.environment.folderUri.toString(),
                    name: env.environment.name,
                    type: env.environment.type,
                  },
            executable: {
              uri: env.executable.uri?.toString(),
              sysPrefix: env.executable.sysPrefix,
            },
          },
  },
});

/**
 * Pyrefly asks for the `python` section. Like the Pyrefly extension, we send
 * the user's `python.pyrefly` and `python.analysis` settings and add the
 * interpreter as `pythonPath`.
 */
const pyreflyConfiguration = Effect.fnUntraced(function* (
  env: py.ResolvedEnvironment | null,
  scopeUri: vscode.Uri | undefined,
) {
  const code = yield* VsCode.Service;
  const python = yield* code.workspace.getConfiguration("python", scopeUri);
  return {
    pyrefly: python.get<unknown>("pyrefly"),
    analysis: python.get<unknown>("analysis"),
    pythonPath: env?.executable.uri?.fsPath,
  };
});

/** Supported servers, in order of preference. */
const SERVERS: ReadonlyArray<ServerSpec> = [
  {
    name: "ty",
    args: ["server"],
    minimumVersion: TY_MINIMUM_VERSION,
    extensionId: TY_EXTENSION_ID,
    configurationSection: "ty",
    configuration: (env) => Effect.succeed(tyConfiguration(env)),
    restartOnSettingsChange: [],
  },
  {
    name: "pyrefly",
    args: ["lsp"],
    minimumVersion: PYREFLY_MINIMUM_VERSION,
    extensionId: PYREFLY_EXTENSION_ID,
    pathSetting: "lspPath",
    binaryDir: ["bin"],
    configurationSection: "python",
    configuration: pyreflyConfiguration,
    restartOnSettingsChange: ["python.pyrefly", "python.analysis"],
  },
];

/**
 * Picks the first server in {@link SERVERS} whose binary resolves.
 *
 * Returns `Option.none()` when no binary is found. Nothing here touches the
 * network, so a blocked package index or an offline machine can't stall
 * startup.
 */
const selectServer = Effect.fnUntraced(function* () {
  const config = yield* Config.Service;
  for (const spec of SERVERS) {
    const resolved = yield* resolveServerBinary(spec, config[spec.name].path);
    if (Option.isSome(resolved)) {
      return Option.some({ spec, resolved: resolved.value });
    }
  }
  return Option.none<{ spec: ServerSpec; resolved: BinarySource }>();
});

/**
 * Builds the one-shot prompt shown when no ty or Pyrefly binary is available.
 *
 *
 * Fires at most once per session (`Effect.cached`) and never again on this
 * machine once the user chooses Don't Show Again. Installing is not dismissal.
 * The local F5 configuration bypasses persistence so reloads can replay it.
 */
export const makeMissingNotifier = Effect.fn(
  "PythonLanguageServer.makeMissingNotifier",
)(function* () {
  const code = yield* VsCode.Service;
  const storage = yield* Storage.Service;
  const trackSetup = Option.match(
    yield* Effect.serviceOption(Telemetry.Service),
    {
      onSome: (telemetry) => telemetry.tySetup,
      onNone: () => () => Effect.void,
    },
  );
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
 * Checks if the managed Python language server should be enabled.
 */
const getDisabledReason = Effect.fn(function* () {
  const config = yield* Config.Service;

  const managedFeaturesEnabled =
    yield* config.getManagedLanguageFeaturesEnabled;

  if (!managedFeaturesEnabled) {
    yield* Effect.logInfo(
      "Managed language features are disabled. Not starting managed Python language server.",
    );
    return Option.some(
      "Managed language features are disabled in marimo settings.",
    );
  }

  return Option.none();
});
