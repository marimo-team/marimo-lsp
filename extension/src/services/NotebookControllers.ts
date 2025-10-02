import * as semver from "@std/semver";
import type * as py from "@vscode/python-extension";
import {
  Brand,
  Data,
  Effect,
  Either,
  Exit,
  FiberSet,
  HashMap,
  Option,
  Ref,
  Scope,
} from "effect";
import type * as vscode from "vscode";
import { unreachable } from "../assert.ts";
import { getNotebookUri } from "../types.ts";
import { findVenvPath } from "../utils/findVenvPath.ts";
import { installPackages } from "../utils/installPackages.ts";
import { Config } from "./Config.ts";
import { EnvironmentValidator } from "./EnvironmentValidator.ts";
import { LanguageClient } from "./LanguageClient.ts";
import { NotebookSerializer } from "./NotebookSerializer.ts";
import { PythonExtension } from "./PythonExtension.ts";
import { Uv } from "./Uv.ts";
import { VsCode } from "./VsCode.ts";

type ControllerId = Brand.Branded<string, "ControllerId">;
const ControllerId = Brand.nominal<ControllerId>();

interface NotebookControllerHandle {
  readonly controller: NotebookController;
  readonly scope: Scope.CloseableScope;
}

/**
 * Manages notebook execution controllers for marimo notebooks,
 * handling controller registration, selection, and execution lifecycle.
 */
class ControllerRegistry extends Effect.Service<ControllerRegistry>()(
  "ControllerRegistry",
  {
    dependencies: [VsCode.Default],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const handlesRef = yield* Ref.make(
        HashMap.empty<ControllerId, NotebookControllerHandle>(),
      );
      const selectionsRef = yield* Ref.make(
        HashMap.empty<vscode.NotebookDocument, NotebookController>(),
      );

      const updateControllerEntry = Effect.fnUntraced(function* (
        id: ControllerId,
        label: string,
      ) {
        const handles = yield* Ref.get(handlesRef);
        const handle = HashMap.get(handles, id);
        if (Option.isSome(handle)) {
          // Just update the controller if it exists
          handle.value.controller.inner.description = label;
          return true;
        }
        return false;
      });

      yield* Effect.addFinalizer(
        Effect.fnUntraced(function* () {
          const controllers = yield* Ref.get(handlesRef);
          yield* Effect.forEach(
            HashMap.values(controllers),
            ({ scope }) => Scope.close(scope, Exit.void),
            { discard: true },
          );
          yield* Ref.set(handlesRef, HashMap.empty());
        }),
      );

      return {
        createOrUpdate: Effect.fnUntraced(function* (env: py.Environment) {
          const controllerId = NotebookController.getId(env);
          const controllerLabel = formatControllerLabel(code, env);

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

          // Create a disposable scope
          const scope = yield* Scope.make();
          const controller = yield* Scope.extend(
            Effect.gen(function* () {
              const runFork = yield* FiberSet.makeRuntime();
              const controller = yield* NotebookController.create({
                env,
                id: controllerId,
                label: controllerLabel,
              });

              yield* controller.onDidChangeSelectedNotebooks((e) => {
                if (!e.selected) {
                  // NB: We don't delete from selections when deselected
                  // because another controller will overwrite it when selected
                  return;
                }
                runFork(
                  Effect.gen(function* () {
                    yield* Ref.update(selectionsRef, (selections) =>
                      HashMap.set(selections, e.notebook, controller),
                    );
                    yield* Effect.logError(
                      "Controller selected for notebook",
                    ).pipe(
                      Effect.annotateLogs({
                        controllerId: controller.inner.id,
                        notebookUri: e.notebook.uri.toString(),
                      }),
                    );
                  }),
                );
              });

              return controller;
            }),
            scope,
          );

          yield* Ref.update(handlesRef, (handles) =>
            HashMap.set(handles, controllerId, { controller, scope }),
          );
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
          const validIds = new Set(
            envs.map((env) => NotebookController.getId(env)),
          );
          const controllers = yield* Ref.get(handlesRef);
          const selections = yield* Ref.get(selectionsRef);

          // Check which controllers can be disposed
          const toRemove: Array<{
            id: ControllerId;
            entry: NotebookControllerHandle;
          }> = [];

          for (const [id, entry] of controllers) {
            if (!validIds.has(id)) {
              // Check if controller is selected for any notebook
              const isInUse = HashMap.some(
                selections,
                (selected) => selected.inner.id === entry.controller.inner.id,
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
            yield* Ref.update(handlesRef, (map) =>
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

export class NotebookControllers extends Effect.Service<NotebookControllers>()(
  "NotebookControllers",
  {
    dependencies: [
      ControllerRegistry.Default,
      PythonExtension.Default,
      EnvironmentValidator.Default,
    ],
    scoped: Effect.gen(function* () {
      const uv = yield* Uv;
      const code = yield* VsCode;
      const config = yield* Config;
      const pyExt = yield* PythonExtension;
      const marimo = yield* LanguageClient;
      const registry = yield* ControllerRegistry;
      const validator = yield* EnvironmentValidator;
      const serializer = yield* NotebookSerializer;

      const runPromise = yield* FiberSet.makeRuntimePromise();

      yield* Effect.logInfo("Setting up notebook controller manager");

      const refreshControllers = () =>
        Effect.gen(function* () {
          const environments = pyExt.environments.known;

          yield* Effect.logDebug("Refreshing controllers").pipe(
            Effect.annotateLogs({ environmentCount: environments.length }),
          );

          // Create or update all current environments
          yield* Effect.forEach(
            environments,
            (env) => registry.createOrUpdate(env),
            { discard: true },
          );

          // Let the state handle disposal logic internally
          yield* registry.removeStale(environments);
        }).pipe(
          Effect.provideService(Uv, uv),
          Effect.provideService(VsCode, code),
          Effect.provideService(Config, config),
          Effect.provideService(PythonExtension, pyExt),
          Effect.provideService(EnvironmentValidator, validator),
          Effect.provideService(LanguageClient, marimo),
          Effect.provideService(NotebookSerializer, serializer),
        );

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
    }).pipe(Effect.annotateLogs("service", "NotebookControllers")),
  },
) {}

/**
 * Format a {@link py.Environment} similar to vscode-jupyter
 *
 * E.g. "EnvName (Python 3.10.2)" or just "Python 3.10.2"
 */
function formatControllerLabel(code: VsCode, env: py.Environment): string {
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
  const envName = resolvePythonEnvironmentName(code, env);
  if (envName) {
    return `${envName} (${formatted})`;
  }
  return formatted;
}

/**
 * A human readable name for a {@link py.Environment}
 */
export function resolvePythonEnvironmentName(
  code: VsCode,
  env: py.Environment,
): string | undefined {
  if (env.environment?.name) {
    return env.environment.name;
  }
  if (env.environment?.folderUri) {
    return code.utils
      .parseUri(env.environment.folderUri.toString())
      .pipe(Either.getOrThrow)
      .path.split("/")
      .pop();
  }
  return undefined;
}

export class NotebookController extends Data.TaggedClass("NotebookController")<{
  readonly inner: vscode.NotebookController;
  readonly env: py.Environment;
}> {
  onDidChangeSelectedNotebooks(
    listener: (options: {
      readonly notebook: vscode.NotebookDocument;
      readonly selected: boolean;
    }) => unknown,
  ) {
    return Effect.acquireRelease(
      Effect.sync(() => this.inner.onDidChangeSelectedNotebooks(listener)),
      (disposable) => Effect.sync(() => disposable.dispose()),
    );
  }
  static getId(env: py.Environment) {
    return ControllerId(`marimo-${env.path}`);
  }
  static create = Effect.fnUntraced(function* (options: {
    id: string;
    label: string;
    env: py.Environment;
  }) {
    const uv = yield* Uv;
    const code = yield* VsCode;
    const config = yield* Config;
    const marimo = yield* LanguageClient;
    const validator = yield* EnvironmentValidator;
    const serializer = yield* NotebookSerializer;

    const runPromise = yield* FiberSet.makeRuntimePromise();

    const controller = yield* code.notebooks.createNotebookController(
      options.id,
      serializer.notebookType,
      options.label,
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
            notebookUri: getNotebookUri(notebook),
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
            EnvironmentInspectionError: Effect.fnUntraced(function* (error) {
              yield* Effect.logError("Python venv check failed", error);

              if (error.cause?._tag === "InvalidExecutableError") {
                yield* code.window.useInfallible((api) =>
                  api.showErrorMessage(
                    `Python executable does not exist for env: ${error.env.path}.`,
                    { modal: true },
                  ),
                );
              } else {
                yield* code.window.useInfallible((api) =>
                  api.showErrorMessage(
                    `Failed to check dependencies in ${formatControllerLabel(code, options.env)}.\n\n` +
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

              // Only prompt to install if uv is enabled
              if (config.uv.enabled) {
                const msg =
                  `${formatControllerLabel(code, options.env)} cannot run the marimo kernel:\n\n` +
                  messages.join("\n") +
                  `\n\nPackages are missing or outdated.\n\nInstall with uv?`;

                const choice = yield* code.window.useInfallible((api) =>
                  api.showErrorMessage(msg, { modal: true }, "Yes"),
                );
                if (!choice) {
                  return;
                }
                const packages = error.diagnostics.map((d) =>
                  d.kind === "outdated"
                    ? `${d.package}>=${semver.format(d.requiredVersion)}`
                    : d.package,
                );
                const venv = findVenvPath(options.env.path);
                if (Option.isNone(venv)) {
                  yield* code.window.useInfallible((api) =>
                    api.showWarningMessage(
                      `Package install failed. No venv found for ${options.env.path}`,
                    ),
                  );
                  return;
                }
                yield* installPackages(venv.value, packages, { uv, code });
              } else {
                const msg =
                  `${formatControllerLabel(code, options.env)} cannot run the marimo kernel:\n\n` +
                  messages.join("\n") +
                  `\n\nPlease install or update the missing packages.`;

                yield* code.window.useInfallible((api) =>
                  api.showErrorMessage(msg, { modal: true }),
                );
              }
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
            notebookUri: getNotebookUri(notebook),
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

    const thisController = new NotebookController({
      inner: controller,
      env: options.env,
    });

    return thisController;
  });
}
