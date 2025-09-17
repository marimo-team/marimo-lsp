import * as childProcess from "node:child_process";
import * as semver from "@std/semver";
import type * as py from "@vscode/python-extension";
import { Data, Effect, Schema } from "effect";
import * as vscode from "vscode";
import type * as lsp from "vscode-languageclient";

import { unreachable } from "./assert.ts";
import * as cmds from "./commands.ts";
import { Logger } from "./logging.ts";
import { getPythonApi } from "./python.ts";
import { SemVerFromString } from "./schemas.ts";
import { notebookType } from "./types.ts";

const MINIMUM_MARIMO_VERSION = {
  major: 0,
  minor: 15,
  patch: 0,
} satisfies semver.SemVer;

export function createNotebookControllerManager(
  client: lsp.BaseLanguageClient,
  options: { signal: AbortSignal },
) {
  const controllers = new Map<string, vscode.NotebookController>();
  const selectedControllers = new WeakMap<
    vscode.NotebookDocument,
    vscode.NotebookController
  >();

  function isControllerInUse(controllerId: string): boolean {
    return vscode.workspace.notebookDocuments.some(
      (doc) => selectedControllers.get(doc)?.id === controllerId,
    );
  }

  function createOrUpdateController(env: py.Environment) {
    const controllerId = `marimo-${env.id}`;
    const controllerLabel = formatControllerLabel(env);

    {
      // Just update the controller if it exists
      const existing = controllers.get(controllerId);
      if (existing) {
        existing.label = controllerLabel;
        Logger.trace(
          "Controller.Update",
          "Updated controller:",
          controllerId,
          controllerLabel,
        );
        return;
      }
    }

    const controller = vscode.notebooks.createNotebookController(
      controllerId,
      notebookType,
      controllerLabel,
      async (cells, notebook, controller) => {
        Logger.info("Controller.Execute", "Running cells", {
          controllerId: controller.id,
          cellCount: cells.length,
          notebook: notebook.uri.toString(),
        });

        const program = checkEnvironmentRequirements(env).pipe(
          Effect.andThen(() =>
            cmds.executeCommandEffect(client, {
              command: "marimo.run",
              params: {
                notebookUri: notebook.uri.toString(),
                inner: {
                  cellIds: cells.map((cell) => cell.document.uri.toString()),
                  codes: cells.map((cell) => cell.document.getText()),
                },
              },
            }),
          ),
          // Known exceptions
          Effect.catchTags({
            ExecuteCommandError: (error) => {
              Logger.error(
                "Controller.Execute",
                "Failed to execute command",
                error,
              );
              return Effect.tryPromise(() =>
                vscode.window.showErrorMessage(
                  "Failed to execute marimo command. Please check the logs for details.",
                  { modal: true },
                ),
              );
            },
            PythonExecutionError: (error) => {
              Logger.error("Controller.Execute", "Python check failed", {
                path: error.env.path,
                stderr: error.stderr,
              });
              return Effect.tryPromise(() =>
                vscode.window.showErrorMessage(
                  `Failed to check dependencies in ${formatControllerLabel(env)}.\n\n` +
                    `Python path: ${error.env.path}`,
                  { modal: true },
                ),
              );
            },
            EnvironmentRequirementError: (error) => {
              Logger.warn(
                "Controller.Execute",
                "Environment requirements not met",
                {
                  env: error.env.path,
                  diagnostics: error.diagnostics,
                },
              );
              const messages = error.diagnostics.map((d) => {
                switch (d.kind) {
                  case "missing":
                    return `• ${d.package}: not installed`;
                  case "outdated":
                    return `• ${d.package}: v${semver.format(d.currentVersion)} (requires >=v${semver.format(d.requiredVersion)})`;
                  case "unknown":
                    return `• ${d.package}: unable to detect`;
                  default:
                    return unreachable();
                }
              });

              const msg =
                `${formatControllerLabel(env)} cannot run the marimo kernel:\n\n` +
                messages.join("\n") +
                `\n\nPlease install or update the missing packages.`;

              return Effect.tryPromise(() =>
                vscode.window.showErrorMessage(msg, { modal: true }),
              );
            },
          }),
          // Unknown exceptions
          Effect.catchTag("UnknownException", (error) => {
            Logger.warn("Controller.Execute", "Unexpected error", error);
            return Effect.async<void, never>((resume) => {
              vscode.window
                .showWarningMessage(
                  "An unexpected error occurred while running the marimo kernel. Check the logs for details.",
                )
                .then(() => resume(Effect.void));
            });
          }),
        );

        return Effect.runPromise<void, never>(program);
      },
    );

    controller.supportedLanguages = ["python"];
    controller.description = env.path;

    const selectionDisposer = controller.onDidChangeSelectedNotebooks((e) => {
      if (e.selected) {
        selectedControllers.set(e.notebook, controller);
        Logger.trace(
          "Controller.Selection",
          `Controller ${controllerId} selected for notebook ${e.notebook.uri.toString()}`,
        );
      }
      // NB: We don't delete from selectedControllers when deselected
      // because another controller will overwrite it when selected
    });

    const originalDispose = controller.dispose.bind(controller);
    controller.dispose = () => {
      selectionDisposer.dispose();
      originalDispose();
    };

    controllers.set(controllerId, controller);
    Logger.trace("Controller.Create", "Created controller:", controllerId);
  }

  function refreshControllers(api: py.PythonExtension) {
    const environments = api.environments.known;
    const currentEnvIds = new Set(environments.map((e) => `marimo-${e.id}`));

    Logger.trace(
      "Controller.Refresh",
      `Refreshing controllers. Found ${environments.length} environments`,
    );

    // Remove controllers for deleted environments (if not in use)
    for (const [id, controller] of controllers) {
      if (!currentEnvIds.has(id)) {
        if (isControllerInUse(id)) {
          Logger.trace(
            "Controller.Skip",
            `Skipping disposal of ${id} - currently in use`,
          );
        } else {
          Logger.trace("Controller.Dispose", `Disposing controller ${id}`);
          controller.dispose();
          controllers.delete(id);
        }
      }
    }

    for (const env of environments) {
      createOrUpdateController(env);
    }
  }

  function initialize(api: py.PythonExtension) {
    refreshControllers(api);

    const envChangeListener = api.environments.onDidChangeEnvironments(() => {
      Logger.trace("Controller.EnvChange", "Python environments changed");
      refreshControllers(api);
    });

    options.signal.addEventListener("abort", () => {
      Logger.info("Controller.Lifecycle", "Disposing controller manager");
      envChangeListener.dispose();
      for (const controller of controllers.values()) {
        controller.dispose();
      }
      controllers.clear();
    });

    Logger.info(
      "Controller.Lifecycle",
      `Controller manager initialized with ${controllers.size} controllers`,
    );
  }

  // TODO: await this somewhere?
  getPythonApi()
    .then((api) => initialize(api))
    .catch((error) => {
      Logger.error(
        "Controller.Error",
        "Failed to initialize controller manager",
        error,
      );
    });

  return {
    /**
     * Get the currently selected controller for a notebook document
     */
    getSelectedController(
      notebook: vscode.NotebookDocument,
    ): vscode.NotebookController | undefined {
      return selectedControllers.get(notebook);
    },
  };
}

/**
 * Format a {@link py.Environment} similar to vscode-jupyter
 *
 * E.g. "EnvName (Python 3.10.2)" or just "Python 3.10.2"
 */
function formatControllerLabel(env: py.Environment): string {
  const versionParts: Array<number> = [];
  if (env.version) {
    if (typeof env.version.major === "number") {
      versionParts.push(env.version.major);
      if (typeof env.version.minor === "number") {
        versionParts.push(env.version.minor);
        if (typeof env.version.micro === "number") {
          versionParts.push(env.version.micro);
        }
      }
    }
  }
  const formatted =
    versionParts.length > 0 ? `Python ${versionParts.join(".")}` : "Python";

  // Format similar to vscode-jupyter: "EnvName (Python 3.10.2)" or just "Python 3.10.2"
  const envName = resolvePythonEnvironmentName(env);
  if (envName) {
    return `${envName} (${formatted})`;
  }
  return formatted;
}

/**
 * A human readable name for a {@link py.Environment}
 */
export function resolvePythonEnvironmentName(
  env: py.Environment,
): string | undefined {
  if (env.environment?.name) {
    return env.environment.name;
  }
  if (env.environment?.folderUri) {
    return vscode.Uri.parse(env.environment.folderUri.toString())
      .path.split("/")
      .pop();
  }
  return undefined;
}

function checkEnvironmentRequirements(
  env: py.Environment,
): Effect.Effect<
  void,
  PythonExecutionError | EnvironmentRequirementError,
  never
> {
  const EnvCheck = Schema.Array(
    Schema.Struct({
      name: Schema.String,
      version: Schema.NullOr(SemVerFromString),
    }),
  );
  return Effect.gen(function* () {
    const stdout = yield* Effect.async<string, PythonExecutionError>(
      (resume) => {
        childProcess.execFile(
          env.path,
          [
            "-c",
            `\
import json

packages = []

try:
    import marimo
    packages.append({"name":"marimo","version":marimo.__version__})
except ImportError:
    packages.append({"name":"marimo","version":None})
    pass

try:
    import zmq
    packages.append({"name":"pyzmq","version":zmq.__version__})
except ImportError:
    packages.append({"name":"pyzmq","version":None})
    pass

print(json.dumps(packages))`,
          ],
          (error, stdout, stderr) => {
            if (!error) {
              resume(Effect.succeed(stdout));
            } else {
              resume(
                Effect.fail(new PythonExecutionError({ env, error, stderr })),
              );
            }
          },
        );
      },
    );

    const packages = yield* Schema.decode(Schema.parseJson(EnvCheck))(
      stdout.trim(),
    ).pipe(
      Effect.mapError(
        () =>
          new EnvironmentRequirementError({
            env,
            diagnostics: [
              { kind: "unknown", package: "marimo" },
              { kind: "unknown", package: "pyzmq" },
            ],
          }),
      ),
    );

    const diagnostics: Array<RequirementDiagnostic> = [];

    for (const pkg of packages) {
      if (pkg.version == null) {
        diagnostics.push({ kind: "missing", package: pkg.name });
      } else if (
        pkg.name === "marimo" &&
        !semver.greaterOrEqual(pkg.version, MINIMUM_MARIMO_VERSION)
      ) {
        diagnostics.push({
          kind: "outdated",
          package: "marimo",
          currentVersion: pkg.version,
          requiredVersion: MINIMUM_MARIMO_VERSION,
        });
      }
    }

    if (diagnostics.length > 0) {
      return yield* new EnvironmentRequirementError({ env, diagnostics });
    }
  });
}

class PythonExecutionError extends Data.TaggedError("PythonExecutionError")<{
  readonly env: py.Environment;
  readonly error: childProcess.ExecFileException;
  readonly stderr: string;
}> {}

type RequirementDiagnostic =
  | { kind: "unknown"; package: string }
  | { kind: "missing"; package: string }
  | {
      kind: "outdated";
      package: string;
      currentVersion: semver.SemVer;
      requiredVersion: semver.SemVer;
    };

class EnvironmentRequirementError extends Data.TaggedError(
  "EnvironmentRequirementError",
)<{
  readonly env: py.Environment;
  readonly diagnostics: ReadonlyArray<RequirementDiagnostic>;
}> {}
