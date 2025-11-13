import type * as py from "@vscode/python-extension";
import {
  Effect,
  Exit,
  HashMap,
  Option,
  Ref,
  Scope,
  Stream,
  SynchronizedRef,
} from "effect";
import type * as vscode from "vscode";
import { formatControllerLabel } from "../utils/formatControllerLabel.ts";
import {
  NotebookControllerFactory,
  type NotebookControllerId,
  VenvPythonController,
} from "./NotebookControllerFactory.ts";
import { PythonExtension } from "./PythonExtension.ts";
import { VsCode } from "./VsCode.ts";

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
    dependencies: [NotebookControllerFactory.Default],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const pyExt = yield* PythonExtension;
      const factory = yield* NotebookControllerFactory;

      const handlesRef = yield* SynchronizedRef.make(
        HashMap.empty<NotebookControllerId, NotebookControllerHandle>(),
      );
      const selectionsRef = yield* Ref.make(
        HashMap.empty<vscode.NotebookDocument, VenvPythonController>(),
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
            }).pipe(
              Effect.provideService(VsCode, code),
              Effect.provideService(NotebookControllerFactory, factory),
            ),
          { discard: true },
        );
        yield* pruneStaleControllers({ envs, handlesRef, selectionsRef });
      });

      yield* refresh();
      yield* Effect.forkScoped(
        pyExt
          .environmentChanges()
          .pipe(Stream.mapEffect(refresh), Stream.runDrain),
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
                  notebookUri: notebook.uri.toString(),
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

const createOrUpdateController = Effect.fnUntraced(function* (options: {
  env: py.Environment;
  handlesRef: SynchronizedRef.SynchronizedRef<
    HashMap.HashMap<NotebookControllerId, NotebookControllerHandle>
  >;
  selectionsRef: Ref.Ref<
    HashMap.HashMap<vscode.NotebookDocument, VenvPythonController>
  >;
}) {
  const code = yield* VsCode;
  const factory = yield* NotebookControllerFactory;
  const { env, selectionsRef, handlesRef } = options;
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
            controller.selectedNotebookChanges().pipe(
              Stream.mapEffect(
                Effect.fnUntraced(function* (e) {
                  if (!e.selected) {
                    // Clear the selection when deselected to avoid stale references
                    const wasSelected = yield* Ref.modify(
                      selectionsRef,
                      (selections) => {
                        const current = HashMap.get(selections, e.notebook);
                        const isCurrentController = Option.match(current, {
                          onSome: (c) => c.id === controller.id,
                          onNone: () => false,
                        });
                        if (isCurrentController) {
                          return [true, HashMap.remove(selections, e.notebook)];
                        }
                        return [false, selections];
                      },
                    );

                    if (wasSelected) {
                      yield* Effect.logDebug(
                        "Controller deselected for notebook, cleared selection",
                      ).pipe(
                        Effect.annotateLogs({
                          controllerId: controller.id,
                          notebookUri: e.notebook.uri.toString(),
                        }),
                      );
                    }
                    return;
                  }
                }),
              ),
              Stream.runDrain,
            ),
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
    HashMap.HashMap<vscode.NotebookDocument, VenvPythonController>
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
