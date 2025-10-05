import type * as py from "@vscode/python-extension";
import {
  Effect,
  Exit,
  HashMap,
  Option,
  Ref,
  Scope,
  SynchronizedRef,
} from "effect";
import type * as vscode from "vscode";
import { formatControllerLabel } from "../utils/formatControllerLabel.ts";
import {
  NotebookController,
  NotebookControllerFactory,
  type NotebookControllerId,
} from "./NotebookControllerFactory.ts";
import { PythonExtension } from "./PythonExtension.ts";
import { VsCode } from "./VsCode.ts";

interface NotebookControllerHandle {
  readonly controller: NotebookController;
  readonly scope: Scope.CloseableScope;
}

/**
 * Manages notebook execution controllers for marimo notebooks,
 * handling controller registration, selection, and execution lifecycle.
 */
export class ControllerRegistry extends Effect.Service<ControllerRegistry>()(
  "ControllerRegistry",
  {
    dependencies: [NotebookControllerFactory.Default],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const pyExt = yield* PythonExtension;
      const factory = yield* NotebookControllerFactory;

      const handlesRef = yield* SynchronizedRef.make(
        HashMap.empty<NotebookControllerId, NotebookControllerHandle>(),
      );
      const selectionsRef = yield* Ref.make(
        HashMap.empty<vscode.NotebookDocument, NotebookController>(),
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
        const envs = pyExt.getKnownEnvironments();
        yield* Effect.logDebug("Refreshing controllers").pipe(
          Effect.annotateLogs({ environmentCount: envs.length }),
        );

        yield* Effect.forEach(
          envs,
          (env) =>
            createOrUpdateController({
              env,
              handlesRef,
              selectionsRef,
              factory,
              code,
            }),
          { discard: true },
        );

        yield* pruneStaleControllers({ envs, handlesRef, selectionsRef });
      });

      yield* refresh();
      yield* pyExt.onDidChangeEnvironments(refresh);

      return {
        getActiveController(notebook: vscode.NotebookDocument) {
          return Effect.map(Ref.get(selectionsRef), HashMap.get(notebook));
        },
      };
    }),
  },
) {}

const createOrUpdateController = Effect.fnUntraced(function* (options: {
  env: py.Environment;
  handlesRef: SynchronizedRef.SynchronizedRef<
    HashMap.HashMap<NotebookControllerId, NotebookControllerHandle>
  >;
  selectionsRef: Ref.Ref<
    HashMap.HashMap<vscode.NotebookDocument, NotebookController>
  >;
  factory: NotebookControllerFactory;
  code: VsCode;
}) {
  const { env, selectionsRef, handlesRef, factory, code } = options;
  const controllerId = NotebookController.getId(env);
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
        existing.value.controller.mutateDescription(controllerLabel);
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

          yield* controller.onDidChangeSelectedNotebooks(
            Effect.fnUntraced(function* (e) {
              if (!e.selected) {
                // NB: We don't delete from selections when deselected
                // because another controller will overwrite it when selected
                return;
              }
              yield* Ref.update(selectionsRef, (selections) =>
                HashMap.set(selections, e.notebook, controller),
              );
              yield* Effect.logDebug("Updated controller for notebook").pipe(
                Effect.annotateLogs({
                  controllerId: controller.id,
                  notebookUri: e.notebook.uri.toString(),
                }),
              );
            }),
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
    HashMap.HashMap<vscode.NotebookDocument, NotebookController>
  >;
}) {
  const { envs, handlesRef, selectionsRef } = options;
  yield* Effect.logDebug("Checking for stale controllers");
  const desiredControllerIds = new Set(
    envs.map((env) => NotebookController.getId(env)),
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
        Effect.logInfo("Completed stale controller removal"),
        { removedCount: toRemove.length },
      );

      return update;
    }),
  );
});
