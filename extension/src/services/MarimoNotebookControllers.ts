import * as NodeFs from "node:fs";
import * as semver from "@std/semver";
import type * as py from "@vscode/python-extension";
import {
  type Brand,
  Effect,
  Exit,
  FiberSet,
  HashMap,
  Option,
  Ref,
  Scope,
} from "effect";
import * as vscode from "vscode";
import { unreachable } from "../assert.ts";
import { MarimoEnvironmentValidator } from "./MarimoEnvironmentValidator.ts";
import { MarimoLanguageClient } from "./MarimoLanguageClient.ts";
import { MarimoNotebookSerializer } from "./MarimoNotebookSerializer.ts";
import { PythonExtension } from "./PythonExtension.ts";
import { VsCode } from "./VsCode.ts";

type ControllerId = string & Brand.Brand<"ControllerId">;

interface ControllerEntry {
  readonly controller: vscode.NotebookController;
  readonly scope: Scope.CloseableScope;
}

export class ControllerRegistry extends Effect.Service<ControllerRegistry>()(
  "ControllerRegistry",
  {
    dependencies: [
      VsCode.Default,
      MarimoLanguageClient.Default,
      MarimoEnvironmentValidator.Default,
      MarimoNotebookSerializer.Default,
    ],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const marimo = yield* MarimoLanguageClient;
      const validator = yield* MarimoEnvironmentValidator;
      const serializer = yield* MarimoNotebookSerializer;

      const controllersRef = yield* Ref.make(
        HashMap.empty<ControllerId, ControllerEntry>(),
      );
      const selectionsRef = yield* Ref.make(
        HashMap.empty<vscode.NotebookDocument, vscode.NotebookController>(),
      );

      const idFor = (env: py.Environment) =>
        `marimo-${env.path}` as ControllerId;

      const updateControllerEntry = Effect.fnUntraced(function* (
        id: ControllerId,
        label: string,
      ) {
        const controllers = yield* Ref.get(controllersRef);
        const maybeEntry = HashMap.get(controllers, id);
        if (Option.isSome(maybeEntry)) {
          // Just update the controller if it exists
          maybeEntry.value.controller.description = label;
          return true;
        }
        return false;
      });

      const addControllerEntry = (id: ControllerId, entry: ControllerEntry) =>
        Ref.update(controllersRef, (controllers) =>
          HashMap.set(controllers, id, entry),
        );

      yield* Effect.addFinalizer(
        Effect.fnUntraced(function* () {
          const controllers = yield* Ref.get(controllersRef);
          yield* Effect.forEach(
            HashMap.values(controllers),
            ({ scope }) => Scope.close(scope, Exit.void),
            { discard: true },
          );
          yield* Ref.set(controllersRef, HashMap.empty());
        }),
      );

      return {
        createOrUpdate: Effect.fnUntraced(function* (env: py.Environment) {
          const controllerId = idFor(env);
          const controllerLabel = formatControllerLabel(env);

          yield* Effect.logDebug("Creating or updating controller").pipe(
            Effect.annotateLogs({
              controllerId,
              pythonPath: env.path,
            }),
          );

          const updated = yield* updateControllerEntry(
            controllerId,
            controllerLabel,
          );

          if (updated) {
            // We updated an existing controller and don't need to recreate
            yield* Effect.logTrace("Controller already exists, updated label");
            return;
          }

          // Make a disposable scope
          const scope = yield* Scope.make();
          const controller = yield* Scope.extend(
            createNewMarimoNotebookController({
              deps: { marimo, code, validator, serializer },
              env,
              controller: {
                id: controllerId,
                label: controllerLabel,
              },
              setActive: (
                controller: vscode.NotebookController,
                notebook: vscode.NotebookDocument,
              ) =>
                Ref.update(selectionsRef, (selections) =>
                  HashMap.set(selections, notebook, controller),
                ),
            }),
            scope,
          );
          yield* addControllerEntry(controllerId, { controller, scope });
          yield* Effect.logInfo("Successfully created new controller");
        }),
        getActiveController: Effect.fnUntraced(function* (
          notebook: vscode.NotebookDocument,
        ) {
          const selections = yield* Ref.get(selectionsRef);
          return HashMap.get(selections, notebook);
        }),
        removeStale: Effect.fnUntraced(function* (
          envs: ReadonlyArray<py.Environment>,
        ) {
          yield* Effect.logDebug("Checking for stale controllers");
          const validIds = new Set(envs.map((env) => idFor(env)));
          const controllers = yield* Ref.get(controllersRef);
          const selections = yield* Ref.get(selectionsRef);

          // Check which controllers can be disposed
          const toRemove: Array<{ id: ControllerId; entry: ControllerEntry }> =
            [];

          for (const [id, entry] of controllers) {
            if (!validIds.has(id)) {
              // Check if controller is selected for any notebook
              const isInUse = HashMap.some(
                selections,
                (selected) => selected.id === entry.controller.id,
              );

              if (!isInUse) {
                toRemove.push({ id, entry });
                yield* Effect.logInfo("Marking controller for removal").pipe(
                  Effect.annotateLogs({ controllerId: id }),
                );
              } else {
                yield* Effect.logTrace(
                  "Keeping controller - still in use",
                ).pipe(Effect.annotateLogs({ controllerId: id }));
              }
            }
          }

          // Close scopes for controllers to be removed
          yield* Effect.forEach(
            toRemove,
            ({ entry }) => Scope.close(entry.scope, Exit.void),
            { discard: true },
          );

          // Remove all disposed controllers in one update
          if (toRemove.length > 0) {
            yield* Ref.update(controllersRef, (map) =>
              toRemove.reduce((acc, { id }) => HashMap.remove(acc, id), map),
            );
            yield* Effect.logInfo("Completed stale controller removal").pipe(
              Effect.annotateLogs({ removedCount: toRemove.length }),
            );
          }
        }),
      };
    }).pipe(Effect.annotateLogs({ component: "notebook-controller" })),
  },
) {}

export class MarimoNotebookControllers extends Effect.Service<MarimoNotebookControllers>()(
  "MarimoNotebookControllers",
  {
    dependencies: [ControllerRegistry.Default, PythonExtension.Default],
    scoped: Effect.gen(function* () {
      const pyExt = yield* PythonExtension;
      const registry = yield* ControllerRegistry;

      const runPromise = yield* FiberSet.makeRuntimePromise();

      yield* Effect.logInfo("Setting up notebook controller manager");

      const refreshControllers = Effect.fnUntraced(function* () {
        const environments = pyExt.environments.known;

        yield* Effect.logDebug("Refreshing controllers").pipe(
          Effect.annotateLogs({ environmentCount: environments.length }),
        );

        // Create or update all current environments
        yield* Effect.forEach(
          environments,
          (env) => registry.createOrUpdate(env),
          {
            discard: true,
          },
        );

        // Let the state handle disposal logic internally
        yield* registry.removeStale(environments);
      });

      // Set up environment monitoring
      yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const api = yield* PythonExtension;
          yield* refreshControllers();
          return api.environments.onDidChangeEnvironments(() =>
            runPromise(refreshControllers()),
          );
        }),
        (disposable) => Effect.sync(() => disposable.dispose()),
      );

      return {
        /**
         * Get the currently selected controller for a notebook document
         */
        getActiveController(notebook: vscode.NotebookDocument) {
          return registry.getActiveController(notebook);
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

const createNewMarimoNotebookController = Effect.fnUntraced(
  function* (options: {
    controller: {
      id: string;
      label: string;
    };
    env: py.Environment;
    setActive: (
      controller: vscode.NotebookController,
      notebook: vscode.NotebookDocument,
    ) => Effect.Effect<void, never, never>;
    deps: {
      code: VsCode;
      marimo: MarimoLanguageClient;
      validator: MarimoEnvironmentValidator;
      serializer: MarimoNotebookSerializer;
    };
  }) {
    const { code, marimo, validator, serializer } = options.deps;
    const runPromise = yield* FiberSet.makeRuntimePromise();

    const controller = yield* Effect.acquireRelease(
      Effect.sync(() =>
        vscode.notebooks.createNotebookController(
          options.controller.id,
          serializer.notebookType,
          options.controller.label,
        ),
      ),
      (disposable) => Effect.sync(() => disposable.dispose()),
    );

    // Add metadata
    controller.supportedLanguages = ["python"];
    controller.description = options.env.path;

    // Set up execution handler
    controller.executeHandler = (cells, notebook, controller) =>
      runPromise(
        Effect.gen(function* () {
          yield* Effect.logInfo("Running cells").pipe(
            Effect.annotateLogs({
              controller: controller.id,
              cellCount: cells.length,
              notebook: notebook.uri.toString(),
            }),
          );
          const validEnv = yield* validator.validate(options.env);
          return yield* marimo.run({
            notebookUri: notebook.uri.toString(),
            executable: validEnv.executable,
            inner: {
              cellIds: cells.map((cell) => cell.document.uri.toString()),
              codes: cells.map((cell) => cell.document.getText()),
            },
          });
        }).pipe(
          // Known exceptions
          Effect.catchTags({
            ExecuteCommandError: Effect.fnUntraced(function* (error) {
              yield* Effect.logError("Failed to execute command", error).pipe(
                Effect.annotateLogs({
                  command: error.command.command,
                }),
              );
              yield* code.window.useInfallible((api) =>
                api.showErrorMessage(
                  "Failed to execute marimo command. Please check the logs for details.",
                  { modal: true },
                ),
              );
            }),
            PythonExecutionError: Effect.fnUntraced(function* (error) {
              yield* Effect.logError("Python check failed", error).pipe(
                Effect.annotateLogs({
                  pythonPath: error.env.path,
                  stderr: error.stderr,
                }),
              );

              // Check if Python executable still exists
              if (!NodeFs.existsSync(error.env.path)) {
                yield* code.window.useInfallible((api) =>
                  api.showErrorMessage(
                    `Python executable does not exist for env: ${error.env.path}.`,
                    { modal: true },
                  ),
                );
              } else {
                yield* code.window.useInfallible((api) =>
                  api.showErrorMessage(
                    `Failed to check dependencies in ${formatControllerLabel(options.env)}.\n\n` +
                      `Python path: ${error.env.path}`,
                    { modal: true },
                  ),
                );
              }
            }),
            EnvironmentRequirementError: Effect.fnUntraced(function* (error) {
              yield* Effect.logWarning("Environment requirements not met").pipe(
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
                `${formatControllerLabel(options.env)} cannot run the marimo kernel:\n\n` +
                messages.join("\n") +
                `\n\nPlease install or update the missing packages.`;

              yield* code.window.useInfallible((api) =>
                api.showErrorMessage(msg, { modal: true }),
              );
            }),
          }),
        ),
      );

    // Set up interrupt handler
    controller.interruptHandler = (notebook) =>
      runPromise(
        Effect.gen(function* () {
          yield* Effect.logInfo("Interrupting execution").pipe(
            Effect.annotateLogs({
              controllerId: controller.id,
              notebook: notebook.uri.toString(),
            }),
          );
          return yield* marimo.interrupt({
            notebookUri: notebook.uri.toString(),
            inner: {},
          });
        }).pipe(
          Effect.catchAllCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logError(cause);
              yield* code.window.useInfallible((api) =>
                api.showErrorMessage(
                  "Failed to interrupt execution. Please check the logs for details.",
                ),
              );
            }),
          ),
        ),
      );

    // Set up selection tracking and add to scope
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        controller.onDidChangeSelectedNotebooks((e) => {
          if (e.selected) {
            runPromise(
              Effect.gen(function* () {
                yield* options.setActive(controller, e.notebook);
                yield* Effect.logTrace("Controller selected for notebook").pipe(
                  Effect.annotateLogs({
                    controllerId: options.controller.id,
                    notebookUri: e.notebook.uri.toString(),
                  }),
                );
              }),
            );
          }
          // NB: We don't delete from selections when deselected
          // because another controller will overwrite it when selected
        }),
      ),
      (disposable) => Effect.sync(() => disposable.dispose()),
    );

    return controller;
  },
);
