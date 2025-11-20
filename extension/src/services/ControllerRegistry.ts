import * as NodePath from "node:path";
import type * as py from "@vscode/python-extension";
import {
  Effect,
  Exit,
  HashMap,
  Option,
  Ref,
  Schema,
  Scope,
  Stream,
  SynchronizedRef,
} from "effect";
import type * as vscode from "vscode";
import { MarimoNotebook } from "../schemas.ts";
import { getNotebookUri } from "../types.ts";
import { findVenvPath } from "../utils/findVenvPath.ts";
import { formatControllerLabel } from "../utils/formatControllerLabel.ts";
import { isMarimoNotebookDocument } from "../utils/notebook.ts";
import {
  NotebookControllerFactory,
  type NotebookControllerId,
  VenvPythonController,
} from "./NotebookControllerFactory.ts";
import { PythonExtension } from "./PythonExtension.ts";
import { SandboxController } from "./SandboxController.ts";
import { Uv } from "./Uv.ts";
import { VsCode } from "./VsCode.ts";

type AnyController = VenvPythonController | SandboxController;

interface NotebookControllerHandle {
  readonly controller: VenvPythonController;
  readonly scope: Scope.CloseableScope;
}

/**
 * Manages notebook execution controllers for marimo notebooks,
 * handling controller registration, selection, and execution lifecycle.
 */
export class ControllerRegistry extends Effect.Service<ControllerRegistry>()(
  "ControllerRegistry",
  {
    dependencies: [
      NotebookControllerFactory.Default,
      SandboxController.Default,
      Uv.Default,
    ],
    scoped: Effect.gen(function* () {
      const uv = yield* Uv;
      const code = yield* VsCode;
      const pyExt = yield* PythonExtension;
      const factory = yield* NotebookControllerFactory;
      const sandboxController = yield* SandboxController;

      const uvCacheDir = yield* uv.getCacheDir().pipe(
        Effect.map((path) => code.Uri.file(path)),
        Effect.tapError((err) =>
          Effect.logError("Failed to get uv cache directory", err),
        ),
        Effect.option,
      );

      const handlesRef = yield* SynchronizedRef.make(
        HashMap.empty<NotebookControllerId, NotebookControllerHandle>(),
      );
      const selectionsRef = yield* Ref.make(
        HashMap.empty<vscode.NotebookDocument, AnyController>(),
      );

      yield* Effect.addFinalizer(() =>
        SynchronizedRef.updateEffect(
          handlesRef,
          Effect.fnUntraced(function* (map) {
            yield* Effect.forEach(
              HashMap.values(map),
              ({ scope }) => Scope.close(scope, Exit.void),
              { discard: true },
            );
            return HashMap.empty();
          }),
        ),
      );

      const refresh = Effect.fnUntraced(function* () {
        const envs = yield* pyExt.knownEnvironments();
        const filteredEnvs = envs.filter(
          (env) =>
            // We only want virtual environments, not global interpreters
            !isGlobalInterpreter(env) &&
            // Uv sandbox environments are handled by the sandbox controller and live
            // in the uv cache directory. We want to skip those so users don't see
            // duplicate controllers.
            !isInUvCache(env, { code, uvCacheDir }),
        );

        yield* Effect.logDebug("Refreshing controllers").pipe(
          Effect.annotateLogs({
            environmentCount: envs.length,
            filteredCount: filteredEnvs.length,
          }),
        );
        yield* Effect.forEach(
          filteredEnvs,
          (env) =>
            createOrUpdateController({
              env,
              handlesRef,
              selectionsRef,
            }).pipe(
              Effect.provideService(VsCode, code),
              Effect.provideService(NotebookControllerFactory, factory),
            ),
          { discard: true },
        );
        yield* pruneStaleControllers({
          envs: filteredEnvs,
          handlesRef,
          selectionsRef,
        });
      });

      yield* refresh();
      yield* Effect.forkScoped(
        pyExt
          .environmentChanges()
          .pipe(Stream.mapEffect(refresh), Stream.runDrain),
      );

      // Subscribe to notebook editor changes to update affinity
      yield* Effect.forkScoped(
        code.window.activeNotebookEditorChanges().pipe(
          Stream.mapEffect(
            Effect.fnUntraced(function* (editor) {
              // Only process marimo notebooks
              if (
                Option.isNone(editor) ||
                !isMarimoNotebookDocument(editor.value.notebook)
              ) {
                return;
              }

              yield* updateNotebookAffinityEffect({
                notebook: editor.value.notebook,
                sandboxController,
                handlesRef,
                code,
              });
            }),
          ),
          Stream.runDrain,
        ),
      );

      // Track sandbox controller selections
      yield* Effect.forkScoped(
        trackControllerSelections(sandboxController, selectionsRef),
      );

      return {
        getActiveController(notebook: vscode.NotebookDocument) {
          return Effect.map(Ref.get(selectionsRef), HashMap.get(notebook));
        },
        // for testing only
        snapshot() {
          return Effect.gen(function* () {
            const handles = yield* SynchronizedRef.get(handlesRef);
            const selections = yield* Ref.get(selectionsRef);
            return {
              controllers: HashMap.toValues(handles)
                .map((handle) => ({
                  id: handle.controller.id,
                  executable: handle.controller.executable,
                }))
                .toSorted((a, b) => a.id.localeCompare(b.id)),
              selections: HashMap.toEntries(selections)
                .map(([notebook, controller]) => ({
                  notebookUri: getNotebookUri(notebook),
                  controllerId: controller.id,
                }))
                .toSorted((a, b) => a.notebookUri.localeCompare(b.notebookUri)),
            };
          });
        },
      };
    }),
  },
) {}

const updateNotebookAffinityEffect = Effect.fnUntraced(function* (options: {
  notebook: vscode.NotebookDocument;
  sandboxController: SandboxController;
  handlesRef: SynchronizedRef.SynchronizedRef<
    HashMap.HashMap<NotebookControllerId, NotebookControllerHandle>
  >;
  code: VsCode;
}) {
  const { notebook, sandboxController, handlesRef, code } = options;
  const handles = yield* SynchronizedRef.get(handlesRef);

  const { header } = yield* Schema.decodeUnknownOption(
    MarimoNotebook.pick("header"),
  )(notebook.metadata);

  // Check if header includes "/// script"
  if (header?.value?.includes("/// script")) {
    yield* Effect.logDebug(
      "Setting affinity to sandbox controller (script header detected)",
    ).pipe(Effect.annotateLogs({ notebookUri: notebook.uri.toString() }));

    // Prefer sandbox controller
    yield* sandboxController.updateNotebookAffinity(
      notebook,
      code.NotebookControllerAffinity.Preferred,
    );

    return;
  }

  // Check for venv next to notebook
  const notebookDir = NodePath.dirname(notebook.uri.fsPath);
  const venvPath = findVenvPath(NodePath.join(notebookDir, ".venv"));

  if (Option.isSome(venvPath)) {
    yield* Effect.logDebug(
      "Setting affinity to venv controller (venv detected)",
    ).pipe(
      Effect.annotateLogs({
        notebookUri: notebook.uri.toString(),
        venvPath: venvPath.value,
      }),
    );

    // Find controller with matching venv path
    // The venv path should contain the Python executable
    const venvControllers = HashMap.filter(handles, (handle) => {
      const controllerVenv = findVenvPath(handle.controller.executable);
      return (
        Option.isSome(controllerVenv) && controllerVenv.value === venvPath.value
      );
    });

    for (const handle of HashMap.values(venvControllers)) {
      yield* handle.controller.updateNotebookAffinity(
        notebook,
        code.NotebookControllerAffinity.Preferred,
      );
    }
    return;
  }

  // Otherwise, don't set any affinity (let VSCode use defaults)
  yield* Effect.logDebug(
    "No affinity preference set (no script header or venv)",
  ).pipe(Effect.annotateLogs({ notebookUri: getNotebookUri(notebook) }));
});

const trackControllerSelections = (
  controller: AnyController,
  selectionsRef: Ref.Ref<
    HashMap.HashMap<vscode.NotebookDocument, AnyController>
  >,
) =>
  controller.selectedNotebookChanges().pipe(
    Stream.mapEffect(
      Effect.fnUntraced(function* (e) {
        if (!e.selected) {
          // NB: We don't delete from selections when deselected
          // because another controller will overwrite it when selected
          return;
        }
        yield* Ref.update(selectionsRef, HashMap.set(e.notebook, controller));
        yield* Effect.logDebug("Updated controller for notebook").pipe(
          Effect.annotateLogs({
            controllerId: controller.id,
            notebookUri: e.notebook.uri.toString(),
          }),
        );
      }),
    ),
    Stream.runDrain,
  );

const createOrUpdateController = Effect.fnUntraced(function* (options: {
  env: py.Environment;
  handlesRef: SynchronizedRef.SynchronizedRef<
    HashMap.HashMap<NotebookControllerId, NotebookControllerHandle>
  >;
  selectionsRef: Ref.Ref<
    HashMap.HashMap<vscode.NotebookDocument, AnyController>
  >;
}) {
  const { env, selectionsRef, handlesRef } = options;
  const code = yield* VsCode;
  const factory = yield* NotebookControllerFactory;
  const controllerId = VenvPythonController.getId(env);
  const controllerLabel = formatControllerLabel(code, env);

  yield* Effect.logDebug("Creating or updating controller").pipe(
    Effect.annotateLogs({ controllerId }),
  );

  yield* SynchronizedRef.updateEffect(
    handlesRef,
    Effect.fnUntraced(function* (map) {
      const existing = HashMap.get(map, controllerId);

      // Just update description if we already have a controller
      if (Option.isSome(existing)) {
        yield* existing.value.controller.mutateDescription(controllerLabel);
        // We updated an existing controller and don't need to recreate
        yield* Effect.annotateLogs(
          Effect.logTrace("Controller already exists, updated label"),
          { controllerId: existing.value.controller.id },
        );
        return map;
      }

      // Create a disposable scope
      const scope = yield* Scope.make();
      const controller = yield* Scope.extend(
        Effect.gen(function* () {
          const controller = yield* factory.createNotebookController({
            env,
            id: controllerId,
            label: controllerLabel,
          });

          yield* Effect.forkScoped(
            trackControllerSelections(controller, selectionsRef),
          );

          return controller;
        }),
        scope,
      );

      yield* Effect.annotateLogs(Effect.logTrace("Created new controller"), {
        controllerId: controller.id,
      });

      return HashMap.set(map, controllerId, { controller, scope });
    }),
  );
});

const pruneStaleControllers = Effect.fnUntraced(function* (options: {
  envs: ReadonlyArray<py.Environment>;
  handlesRef: SynchronizedRef.SynchronizedRef<
    HashMap.HashMap<NotebookControllerId, NotebookControllerHandle>
  >;
  selectionsRef: Ref.Ref<
    HashMap.HashMap<vscode.NotebookDocument, AnyController>
  >;
}) {
  const { envs, handlesRef, selectionsRef } = options;
  yield* Effect.logDebug("Checking for stale controllers");
  const desiredControllerIds = new Set(
    envs.map((env) => VenvPythonController.getId(env)),
  );

  yield* SynchronizedRef.updateEffect(
    handlesRef,
    Effect.fnUntraced(function* (map) {
      const selections = yield* Ref.get(selectionsRef);

      // Check which controllers can be disposed
      const toRemove: Array<NotebookControllerHandle> = [];
      for (const [controllerId, handle] of map) {
        if (desiredControllerIds.has(controllerId)) {
          continue;
        }

        const inUse = HashMap.some(
          selections,
          (selected) => selected.id === handle.controller.id,
        );
        if (inUse) {
          yield* Effect.annotateLogs(
            Effect.logWarning("Controller in use. Skipping removal."),
            { controllerId: handle.controller.id },
          );
          continue;
        }

        toRemove.push(handle);
      }

      // Close scopes for controllers to be removed
      yield* Effect.forEach(
        toRemove,
        (handle) => Scope.close(handle.scope, Exit.void),
        { discard: true },
      );

      const update = toRemove.reduce(
        (acc, handle) => HashMap.remove(acc, handle.controller.id),
        map,
      );

      // Remove all disposed controllers in one update
      yield* Effect.annotateLogs(
        Effect.logDebug("Completed stale controller removal"),
        { removedCount: toRemove.length },
      );

      return update;
    }),
  );
});

/**
 * Determines if the given Python environment is a global interpreter.
 *
 * From the docs:
 *
 * py.Environment.environment - carries details if it is an environment, otherwise
 * `undefined` in case of global interpreters and others.
 *
 * @param env The Python environment to check.
 * @returns True if the environment is global, false otherwise.
 */
function isGlobalInterpreter(env: py.Environment): boolean {
  return env.environment === undefined;
}

/**
 * Determines if the given Python environment is located within the uv cache directory.
 *
 * We keep all our sandboxed environments in the uv cache directory,
 * so this function helps identify those environments.
 *
 * @param env The Python environment to check.
 * @param uvCacheDir The uv cache directory URI.
 * @returns True if the environment is in the uv cache, false otherwise.
 */
function isInUvCache(
  env: py.Environment,
  options: {
    code: VsCode;
    uvCacheDir: Option.Option<vscode.Uri>;
  },
) {
  if (Option.isNone(options.uvCacheDir)) {
    return false;
  }

  try {
    const envPath = options.code.Uri.file(env.path).fsPath;
    return envPath.startsWith(options.uvCacheDir.value.fsPath);
  } catch {
    return false;
  }
}
