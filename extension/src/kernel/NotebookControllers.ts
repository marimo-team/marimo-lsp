import * as NodePath from "node:path";

import type * as py from "@vscode/python-extension";
import {
  Cause,
  Effect,
  Exit,
  Filter,
  HashMap,
  Layer,
  Option,
  Scope,
  Stream,
  SynchronizedRef,
} from "effect";
import type * as vscode from "vscode";

import { Config } from "../config/Config.ts";
import { formatControllerLabel } from "../lib/formatControllerLabel.ts";
import { NotebookSerializer } from "../notebook/NotebookSerializer.ts";
import { Constants } from "../platform/Constants.ts";
import { OutputChannel } from "../platform/OutputChannel.ts";
import { VsCode } from "../platform/VsCode.ts";
import { EnvironmentValidator } from "../python/EnvironmentValidator.ts";
import { findVenvPath } from "../python/findVenvPath.ts";
import { PythonExtension } from "../python/PythonExtension.ts";
import { Uv } from "../python/Uv.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";
import {
  type NotebookController as RuntimeNotebookController,
  NotebookRuntime,
} from "./NotebookRuntime.ts";
import {
  createPythonController,
  type NotebookControllerId,
  PythonController,
} from "./PythonController.ts";
import { createSandboxController } from "./SandboxController.ts";
import { VsCodeCellDrive } from "./VsCodeCellDrive.ts";
import { VsCodeNotebookOutputPresenter } from "./VsCodeNotebookOutputPresenter.ts";

export interface NotebookController extends RuntimeNotebookController {
  readonly selectedNotebookChanges: Stream.Stream<{
    notebook: vscode.NotebookDocument;
    selected: boolean;
  }>;
  readonly updateNotebookAffinity: (
    notebook: vscode.NotebookDocument,
    affinity: vscode.NotebookControllerAffinity,
  ) => Effect.Effect<void>;
}

interface NotebookControllerHandle {
  readonly controller: PythonController;
  readonly scope: Scope.Closeable;
}

/**
 * Creates the VS Code controllers available to marimo notebooks and attaches
 * controller selections to NotebookRuntime.
 */
export const NotebookControllersLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const uv = yield* Uv;
    const code = yield* VsCode;
    const pyExt = yield* PythonExtension;
    const notebooks = yield* NotebookRuntime;
    const sandboxController = yield* createSandboxController();

    const uvCacheDir = yield* uv.getCacheDir.pipe(
      Effect.map((path) => code.Uri.file(path)),
      Effect.tapError((err) =>
        Effect.logError("Failed to get uv cache directory").pipe(
          Effect.annotateLogs({ cause: Cause.fail(err) }),
        ),
      ),
      Effect.option,
    );

    const handlesRef = yield* SynchronizedRef.make(
      HashMap.empty<NotebookControllerId, NotebookControllerHandle>(),
    );

    yield* Effect.addFinalizer(() =>
      SynchronizedRef.updateEffect(
        handlesRef,
        Effect.fn(function* (map) {
          yield* Effect.forEach(
            HashMap.values(map),
            ({ scope }) => Scope.close(scope, Exit.void),
            { discard: true },
          );
          return HashMap.empty();
        }),
      ),
    );

    const refresh = Effect.fn("NotebookControllers.refresh")(function* () {
      const envs = yield* pyExt.knownEnvironments;
      const filteredEnvs = envs.filter(
        (env) =>
          // Uv sandbox environments are handled by the sandbox controller and live
          // in the uv cache directory. We want to skip those so users don't see
          // duplicate controllers.
          !isInUvCache(env, { code, uvCacheDir }),
      );

      yield* Effect.annotateCurrentSpan("environmentCount", envs.length);
      yield* Effect.annotateCurrentSpan("filteredCount", filteredEnvs.length);

      yield* Effect.forEach(
        filteredEnvs,
        (env) =>
          createOrUpdateController({
            env,
            handlesRef,
            notebooks,
          }).pipe(Effect.provideService(VsCode, code)),
        { discard: true },
      );
      yield* pruneStaleControllers({
        envs: filteredEnvs,
        handlesRef,
        notebooks,
      });
    });

    yield* refresh();
    yield* Effect.forkScoped(
      pyExt.environmentChanges.pipe(Stream.runForEach(refresh)),
    );

    // Subscribe to notebook editor changes to update affinity
    yield* Effect.forkScoped(
      code.window.activeNotebookEditorChanges.pipe(
        Stream.filterMap(
          Filter.fromPredicateOption((maybeEditor) => maybeEditor),
        ),
        Stream.filterMap(
          Filter.fromPredicateOption(({ notebook }) =>
            MarimoNotebookDocument.tryFrom(notebook),
          ),
        ),
        Stream.runForEach((notebook) =>
          updateNotebookAffinityEffect({
            notebook,
            sandboxController,
            handlesRef,
            code,
          }),
        ),
      ),
    );

    // Track sandbox controller selections
    yield* Effect.forkScoped(
      trackControllerSelections(sandboxController, notebooks),
    );
  }),
).pipe(
  Layer.provide(VsCodeCellDrive.layer),
  Layer.provide(VsCodeNotebookOutputPresenter.layer),
  Layer.provide(Uv.layer),
  Layer.provide(OutputChannel.layer),
  Layer.provide(Config.layer),
  Layer.provide(Constants.layer),
  Layer.provide(EnvironmentValidator.layer),
  Layer.provide(NotebookSerializer.layer),
);

const updateNotebookAffinityEffect = Effect.fn("updateNotebookAffinity")(
  function* (options: {
    notebook: MarimoNotebookDocument;
    sandboxController: NotebookController;
    handlesRef: SynchronizedRef.SynchronizedRef<
      HashMap.HashMap<NotebookControllerId, NotebookControllerHandle>
    >;
    code: VsCode["Service"];
  }) {
    const { notebook, sandboxController, handlesRef, code } = options;
    const handles = yield* SynchronizedRef.get(handlesRef);

    // Check if header includes "/// script"
    if (notebook.header.includes("/// script")) {
      yield* Effect.logDebug(
        "Setting affinity to sandbox controller (script header detected)",
      ).pipe(Effect.annotateLogs({ notebookUri: notebook.uri.toString() }));

      // Prefer sandbox controller
      yield* sandboxController.updateNotebookAffinity(
        notebook.rawNotebookDocument,
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
          notebookUri: notebook.id,
          venvPath: venvPath.value,
        }),
      );

      // Find controller with matching venv path
      // The venv path should contain the Python executable
      const venvControllers = HashMap.filter(handles, (handle) => {
        const controllerVenv = findVenvPath(handle.controller.executable);
        return (
          Option.isSome(controllerVenv) &&
          controllerVenv.value === venvPath.value
        );
      });

      for (const handle of HashMap.values(venvControllers)) {
        yield* handle.controller.updateNotebookAffinity(
          notebook.rawNotebookDocument,
          code.NotebookControllerAffinity.Preferred,
        );
      }
      return;
    }

    // Otherwise, don't set any affinity (let VSCode use defaults)
    yield* Effect.logDebug(
      "No affinity preference set (no script header or venv)",
    ).pipe(Effect.annotateLogs({ notebookUri: notebook.id }));
  },
);

const trackControllerSelections = (
  controller: NotebookController,
  notebooks: NotebookRuntime["Service"],
) =>
  controller.selectedNotebookChanges.pipe(
    Stream.runForEach(
      Effect.fn(function* (e) {
        if (!e.selected) {
          // NB: We don't delete from selections when deselected
          // because another controller will overwrite it when selected
          return;
        }
        const notebook = MarimoNotebookDocument.from(e.notebook);
        yield* notebooks.attachController(notebook.id, controller);
        yield* Effect.logTrace("Updated controller for notebook").pipe(
          Effect.annotateLogs({
            controllerId: controller.id,
            notebookUri: notebook.id,
          }),
        );
      }),
    ),
  );

const createOrUpdateController = Effect.fn(
  "NotebookControllers.createOrUpdate",
)(function* (options: {
  env: py.Environment;
  handlesRef: SynchronizedRef.SynchronizedRef<
    HashMap.HashMap<NotebookControllerId, NotebookControllerHandle>
  >;
  notebooks: NotebookRuntime["Service"];
}) {
  const { env, handlesRef, notebooks } = options;
  const code = yield* VsCode;
  const controllerId = PythonController.getId(env);
  const controllerLabel = formatControllerLabel(code, env);

  yield* Effect.annotateCurrentSpan("controllerId", controllerId);

  yield* SynchronizedRef.updateEffect(
    handlesRef,
    Effect.fn(function* (map) {
      const existing = HashMap.get(map, controllerId);

      // Just update description if we already have a controller
      if (Option.isSome(existing)) {
        yield* existing.value.controller.mutateDescription(controllerLabel);
        yield* Effect.logTrace("Controller already exists, updated label");
        return map;
      }

      // Create a disposable scope
      const scope = yield* Scope.make();
      const controller = yield* Scope.provide(
        Effect.gen(function* () {
          const controller = yield* createPythonController({
            env,
            id: controllerId,
            label: controllerLabel,
          });

          yield* Effect.forkScoped(
            trackControllerSelections(controller, notebooks),
          );

          return controller;
        }),
        scope,
      );

      yield* Effect.logTrace("Created new controller");

      return HashMap.set(map, controllerId, { controller, scope });
    }),
  );
});

const pruneStaleControllers = Effect.fn("pruneStaleControllers")(
  function* (options: {
    envs: ReadonlyArray<py.Environment>;
    handlesRef: SynchronizedRef.SynchronizedRef<
      HashMap.HashMap<NotebookControllerId, NotebookControllerHandle>
    >;
    notebooks: NotebookRuntime["Service"];
  }) {
    const { envs, handlesRef, notebooks } = options;
    yield* Effect.logTrace("Checking for stale controllers");
    const desiredControllerIds = new Set(
      envs.map((env) => PythonController.getId(env)),
    );
    const code = yield* VsCode;
    const selectedControllerIds = new Set<string>();
    const documents = yield* code.workspace.getNotebookDocuments;
    for (const rawDocument of documents) {
      const notebook = MarimoNotebookDocument.tryFrom(rawDocument);
      if (Option.isNone(notebook)) continue;
      const handle = yield* notebooks.forNotebook(notebook.value.id);
      const controller = yield* handle.getController;
      if (Option.isSome(controller)) {
        selectedControllerIds.add(controller.value.id);
      }
    }

    yield* SynchronizedRef.updateEffect(
      handlesRef,
      Effect.fn(function* (map) {
        // Check which controllers can be disposed
        const toRemove: Array<NotebookControllerHandle> = [];
        for (const [controllerId, handle] of map) {
          if (desiredControllerIds.has(controllerId)) {
            continue;
          }

          if (selectedControllerIds.has(handle.controller.id)) {
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
          Effect.logTrace("Completed stale controller removal"),
          { removedCount: toRemove.length },
        );

        return update;
      }),
    );
  },
);

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
    code: VsCode["Service"];
    uvCacheDir: Option.Option<vscode.Uri>;
  },
) {
  if (Option.isNone(options.uvCacheDir)) {
    return false;
  }

  try {
    const envPath = options.code.Uri.file(env.path).fsPath;
    return isPathInsideDirectory(envPath, options.uvCacheDir.value.fsPath);
  } catch {
    return false;
  }
}

export function isPathInsideDirectory(
  candidatePath: string,
  directoryPath: string,
): boolean {
  const relative = NodePath.relative(directoryPath, candidatePath);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
}
