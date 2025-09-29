import * as semver from "@std/semver";
import type * as py from "@vscode/python-extension";
import { Effect, FiberSet } from "effect";
import * as vscode from "vscode";
import { unreachable } from "../assert.ts";
import { MarimoEnvironmentValidator } from "./MarimoEnvironmentValidator.ts";
import { MarimoLanguageClient } from "./MarimoLanguageClient.ts";
import { MarimoNotebookSerializer } from "./MarimoNotebookSerializer.ts";
import { PythonExtension } from "./PythonExtension.ts";

export class MarimoNotebookControllerManager extends Effect.Service<MarimoNotebookControllerManager>()(
  "MarimoNotebookControllerManager",
  {
    dependencies: [MarimoEnvironmentValidator.Default],
    scoped: Effect.gen(function* () {
      const serializer = yield* MarimoNotebookSerializer;
      const validator = yield* MarimoEnvironmentValidator;

      yield* Effect.logInfo("Setting up notebook controller manager").pipe(
        Effect.annotateLogs({ component: "notebook-controller" }),
      );
      const runPromise = yield* FiberSet.makeRuntimePromise<
        MarimoLanguageClient,
        void,
        never
      >();

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
            Effect.logTrace("Updated controller").pipe(
              Effect.annotateLogs({ controllerId, controllerLabel }),
              Effect.runSync,
            );
            return;
          }
        }

        const controller = vscode.notebooks.createNotebookController(
          controllerId,
          serializer.notebookType,
          controllerLabel,
          (cells, notebook, controller) =>
            Effect.gen(function* () {
              yield* Effect.logInfo("Running cells");
              yield* Effect.logTrace("Running cells", cells);
              const validEnv = yield* validator.validate(env);
              const marimo = yield* MarimoLanguageClient;
              return yield* marimo.run({
                notebookUri: notebook.uri.toString(),
                executable: validEnv.executable,
                inner: {
                  cellIds: cells.map((cell) => cell.document.uri.toString()),
                  codes: cells.map((cell) => cell.document.getText()),
                },
              });
            }).pipe(
              Effect.annotateLogs({
                controller: controller.id,
                cellCount: cells.length,
                notebook: notebook.uri.toString(),
              }),
              // Known exceptions
              Effect.catchTags({
                ExecuteCommandError: (error) =>
                  Effect.gen(function* () {
                    yield* Effect.logError(
                      "Failed to execute command",
                      error,
                    ).pipe(
                      Effect.annotateLogs({
                        command: error.command.command,
                      }),
                    );
                    return yield* Effect.promise(() =>
                      vscode.window.showErrorMessage(
                        "Failed to execute marimo command. Please check the logs for details.",
                        { modal: true },
                      ),
                    );
                  }),
                PythonExecutionError: (error) =>
                  Effect.gen(function* () {
                    yield* Effect.logError("Python check failed", error).pipe(
                      Effect.annotateLogs({
                        pythonPath: error.env.path,
                        stderr: error.stderr,
                      }),
                    );
                    return yield* Effect.promise(() =>
                      vscode.window.showErrorMessage(
                        `Failed to check dependencies in ${formatControllerLabel(env)}.\n\n` +
                          `Python path: ${error.env.path}`,
                        { modal: true },
                      ),
                    );
                  }),
                EnvironmentRequirementError: (error) =>
                  Effect.gen(function* () {
                    yield* Effect.logWarning(
                      "Environment requirements not met",
                    ).pipe(
                      Effect.annotateLogs({
                        pythonPath: error.env.path,
                        diagnostics: error.diagnostics,
                      }),
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
                          return unreachable(d);
                      }
                    });

                    const msg =
                      `${formatControllerLabel(env)} cannot run the marimo kernel:\n\n` +
                      messages.join("\n") +
                      `\n\nPlease install or update the missing packages.`;

                    return yield* Effect.promise(() =>
                      vscode.window.showErrorMessage(msg, { modal: true }),
                    );
                  }),
              }),
              runPromise,
            ),
        );

        controller.supportedLanguages = ["python"];
        controller.description = env.path;

        controller.interruptHandler = (notebook) =>
          Effect.gen(function* () {
            yield* Effect.logInfo("Interrupting execution").pipe(
              Effect.annotateLogs({
                controllerId: controller.id,
                notebook: notebook.uri.toString(),
              }),
            );
            const marimo = yield* MarimoLanguageClient;
            return yield* marimo.interrupt({
              notebookUri: notebook.uri.toString(),
              inner: {},
            });
          }).pipe(
            Effect.catchAllCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logError(cause);
                yield* Effect.promise(() =>
                  vscode.window.showErrorMessage(
                    "Failed to interrupt execution. Please check the logs for details.",
                  ),
                );
              }),
            ),
            runPromise,
          );

        const selectionDisposer = controller.onDidChangeSelectedNotebooks(
          (e) => {
            if (e.selected) {
              selectedControllers.set(e.notebook, controller);
              Effect.logTrace("Controller selected for notebook").pipe(
                Effect.annotateLogs({
                  controllerId,
                  notebookUri: e.notebook.uri.toString(),
                }),
                Effect.runSync,
              );
            }
            // NB: We don't delete from selectedControllers when deselected
            // because another controller will overwrite it when selected
          },
        );

        const originalDispose = controller.dispose.bind(controller);
        controller.dispose = () => {
          Effect.logTrace("Disposing controller").pipe(
            Effect.annotateLogs({ controllerId }),
            Effect.runSync,
          );
          selectionDisposer.dispose();
          originalDispose();
        };

        controllers.set(controllerId, controller);
        Effect.logTrace("Created controller").pipe(
          Effect.annotateLogs({ controllerId }),
          Effect.runSync,
        );
      }

      function refreshControllers(api: PythonExtension) {
        const environments = api.environments.known;
        const currentEnvIds = new Set(
          environments.map((e) => `marimo-${e.id}`),
        );

        Effect.logTrace("Refreshing controllers").pipe(
          Effect.annotateLogs({ environmentCount: environments.length }),
          Effect.runSync,
        );

        // Remove controllers for deleted environments (if not in use)
        for (const [id, controller] of controllers) {
          if (!currentEnvIds.has(id)) {
            if (isControllerInUse(id)) {
              Effect.logTrace("Skipping disposal - controller in use").pipe(
                Effect.annotateLogs({ controllerId: id }),
                Effect.runSync,
              );
            } else {
              Effect.logTrace("Disposing controller").pipe(
                Effect.annotateLogs({ controllerId: id }),
                Effect.runSync,
              );
              controller.dispose();
              controllers.delete(id);
            }
          }
        }

        for (const env of environments) {
          createOrUpdateController(env);
        }
      }

      yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const api = yield* PythonExtension;
          refreshControllers(api);
          return api.environments.onDidChangeEnvironments(() => {
            Effect.logTrace("Python environments changed").pipe(
              Effect.annotateLogs({ component: "notebook-controller" }),
              Effect.runSync,
            );
            refreshControllers(api);
          });
        }),
        (disposable) => Effect.sync(() => disposable.dispose()),
      );

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.logInfo("Tearing down notebook controller manager");
          for (const controller of controllers.values()) {
            controller.dispose();
          }
          controllers.clear();
          yield* Effect.logInfo("All controllers disposed");
        }),
      );

      yield* Effect.logInfo("Notebook controller manager initialized");

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
    }),
  },
) {}

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
