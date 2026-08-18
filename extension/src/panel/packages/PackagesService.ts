import {
  Context,
  Effect,
  HashMap,
  Layer,
  Option,
  Stream,
  SubscriptionRef,
} from "effect";

import {
  type NotebookController,
  NotebookRuntime,
} from "../../kernel/NotebookRuntime.ts";
import { MarimoClient } from "../../lsp/MarimoClient.ts";
import {
  type NotebookDocumentSession,
  NotebookDocumentSessions,
} from "../../notebook/NotebookDocumentSessions.ts";
import { NotebookEditorRegistry } from "../../notebook/NotebookEditorRegistry.ts";
import { MarimoNotebookDocument } from "../../schemas/MarimoNotebookDocument.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import type {
  DependencyTreeNode,
  PackageSource,
} from "../../schemas/Models.gen.ts";

/**
 * Derive how to ask the server about a notebook's python environment from
 * the controller that's currently selected. Environment controllers know
 * their executable up front (`venv` mode); the sandbox controller doesn't and
 * the server resolves the env via `uv tree --script <file>` (`script` mode).
 */
function controllerSource(controller: NotebookController): PackageSource {
  return typeof controller.executable === "string"
    ? { kind: "venv", executable: controller.executable }
    : { kind: "script" };
}

interface DependencyTreeState {
  tree: DependencyTreeNode | null;
  loading: boolean;
  error: string | null;
}

/**
 * Manages dependency trees for notebooks.
 *
 * Stores dependency trees (NotebookUri -> DependencyTreeState) in a
 * SubscriptionRef for reactive state management.
 */
export class PackagesService extends Context.Service<PackagesService>()(
  "PackagesService",
  {
    make: Effect.gen(function* () {
      const marimo = yield* MarimoClient;
      const notebooks = yield* NotebookRuntime;
      const editors = yield* NotebookEditorRegistry;
      const documentSessions = yield* NotebookDocumentSessions;

      // Track dependency trees: NotebookUri -> DependencyTreeState
      const dependencyTreesRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, DependencyTreeState>(),
      );
      const cacheOwners = new Map<NotebookId, NotebookDocumentSession>();
      const cacheGenerations = new Map<NotebookId, symbol>();
      const generationFor = (notebookUri: NotebookId) => {
        const existing = cacheGenerations.get(notebookUri);
        if (existing !== undefined) return existing;
        const generation = Symbol("package cache generation");
        cacheGenerations.set(notebookUri, generation);
        return generation;
      };
      const clearCache = (
        notebookUri: NotebookId,
        expectedOwner?: NotebookDocumentSession,
      ) =>
        SubscriptionRef.update(dependencyTreesRef, (map) => {
          if (
            expectedOwner !== undefined &&
            cacheOwners.get(notebookUri) !== expectedOwner
          ) {
            return map;
          }
          cacheOwners.delete(notebookUri);
          // Deleting keeps the map bounded; an in-flight operation holding
          // the old symbol fails the equality check either way.
          cacheGenerations.delete(notebookUri);
          return HashMap.remove(map, notebookUri);
        }).pipe(
          Effect.tap(() =>
            Effect.logTrace("Cleared package data").pipe(
              Effect.annotateLogs({ notebookUri }),
            ),
          ),
        );

      yield* Effect.forkScoped(
        documentSessions.changes.pipe(
          Stream.runForEach((change) =>
            change._tag === "Ended"
              ? clearCache(change.session.notebookId, change.session)
              : Effect.void,
          ),
        ),
      );

      return {
        /**
         * Get dependency tree state for a notebook
         */
        getDependencyTree(notebookUri: NotebookId) {
          // Eviction on session end is asynchronous; never serve an entry a
          // previous document session cached.
          return Effect.map(SubscriptionRef.get(dependencyTreesRef), (map) =>
            HashMap.get(map, notebookUri).pipe(
              Option.filter(() => {
                const owner = cacheOwners.get(notebookUri);
                return (
                  owner !== undefined &&
                  owner === documentSessions.current(notebookUri)
                );
              }),
            ),
          );
        },

        /**
         * Fetch dependency tree from the language server
         * Caches the result in dependencyTreesRef and re-uses if already cached
         */
        fetchDependencyTree(notebookUri: NotebookId) {
          return Effect.gen(function* () {
            const session = documentSessions.current(notebookUri);
            const generation = generationFor(notebookUri);
            const updateIfCurrent = (
              update: (
                map: HashMap.HashMap<NotebookId, DependencyTreeState>,
              ) => HashMap.HashMap<NotebookId, DependencyTreeState>,
            ) =>
              SubscriptionRef.update(dependencyTreesRef, (map) => {
                if (
                  session === undefined ||
                  documentSessions.current(notebookUri) !== session ||
                  cacheGenerations.get(notebookUri) !== generation
                ) {
                  return map;
                }
                cacheOwners.set(notebookUri, session);
                return update(map);
              });

            // Check if we already have a cached tree
            const cached = yield* SubscriptionRef.get(dependencyTreesRef);
            const existing = HashMap.get(cached, notebookUri);

            // If we have a tree and it's not in error state, re-use it
            if (
              Option.isSome(existing) &&
              session !== undefined &&
              cacheOwners.get(notebookUri) === session &&
              existing.value.tree &&
              !existing.value.error
            ) {
              yield* Effect.logTrace("Re-using cached dependency tree").pipe(
                Effect.annotateLogs({ notebookUri }),
              );
              return existing.value.tree;
            }

            // Get the active controller; its `target` describes how to ask
            // the server about the env (`venv` with an executable, or `script`).
            const activeNotebook = Option.flatMap(
              yield* editors.getActiveNotebookEditor,
              (editor) => MarimoNotebookDocument.tryFrom(editor.notebook),
            );
            if (Option.isNone(activeNotebook)) {
              yield* Effect.logWarning("Could not find marimo-notebook editor");
              return null;
            }

            const activeController = yield* notebooks.forNotebook(
              activeNotebook.value.id,
            ).getController;
            if (Option.isNone(activeController)) {
              yield* updateIfCurrent((map) =>
                HashMap.set(map, notebookUri, {
                  tree: null,
                  loading: false,
                  error: "No kernel selected",
                }),
              );
              yield* Effect.logDebug(
                "No active controller; skipping dependency tree fetch",
              ).pipe(Effect.annotateLogs({ notebookUri }));
              return null;
            }

            const source = controllerSource(activeController.value);
            yield* updateIfCurrent((map) =>
              HashMap.set(
                map,
                notebookUri,
                Option.match(HashMap.get(map, notebookUri), {
                  onNone: () => ({
                    tree: null,
                    loading: true,
                    error: null,
                  }),
                  onSome: (value) => ({ ...value, loading: true }),
                }),
              ),
            );

            // Fetch from language server
            const next = yield* marimo
              .getDependencyTree({
                notebookUri,
                source,
                inner: {},
              })
              .pipe(
                Effect.tap((result) =>
                  Effect.logTrace("Fetched dependency tree").pipe(
                    Effect.annotateLogs({ notebookUri, result }),
                  ),
                ),
                Effect.map(
                  (result): DependencyTreeState => ({
                    tree: result.tree,
                    loading: false,
                    error: null,
                  }),
                ),
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    const errorMsg = String(error);

                    // Script mode has no useful fallback — `uv tree --script`
                    // is the only path that resolves PEP 723 metadata.
                    if (source.kind === "script") {
                      yield* Effect.logError(
                        "Dependency tree failed for script mode",
                      ).pipe(
                        Effect.annotateLogs({ notebookUri, error: errorMsg }),
                      );
                      return {
                        tree: null,
                        loading: false,
                        error: errorMsg,
                      } satisfies DependencyTreeState;
                    }

                    yield* Effect.logWarning(
                      "Dependency tree failed, falling back to package list",
                    ).pipe(
                      Effect.annotateLogs({ notebookUri, error: errorMsg }),
                    );

                    // Venv fallback: fetch the flat package list (which the
                    // server backs with `uv pip list -p <exe>`) and synthesize
                    // a single-level tree from it.
                    return yield* marimo
                      .getPackageList({
                        notebookUri,
                        source,
                        inner: {},
                      })
                      .pipe(
                        Effect.map(
                          (packageListRaw): DependencyTreeState => ({
                            tree: {
                              name: "installed-packages",
                              version: null,
                              tags: [],
                              dependencies: packageListRaw.packages.map(
                                (pkg) => ({
                                  name: pkg.name,
                                  version: pkg.version,
                                  tags: [],
                                  dependencies: [],
                                }),
                              ),
                            },
                            loading: false,
                            error: null,
                          }),
                        ),
                        Effect.catch((fallbackError) =>
                          Effect.gen(function* () {
                            const fallbackErrorMsg = String(fallbackError);
                            yield* Effect.logError(
                              "Package list fallback also failed",
                            ).pipe(
                              Effect.annotateLogs({
                                notebookUri,
                                error: fallbackErrorMsg,
                              }),
                            );
                            return {
                              tree: null,
                              loading: false,
                              error: `${errorMsg}; fallback also failed: ${fallbackErrorMsg}`,
                            } satisfies DependencyTreeState;
                          }),
                        ),
                      );
                  }),
                ),
              );

            yield* updateIfCurrent((map) =>
              HashMap.set(map, notebookUri, next),
            );
            if (
              session !== undefined &&
              documentSessions.current(notebookUri) === session &&
              cacheGenerations.get(notebookUri) === generation
            ) {
              yield* Effect.logTrace("Cached dependency tree").pipe(
                Effect.annotateLogs({
                  notebookUri,
                  hasTree: next.tree !== null,
                }),
              );
            }

            return next.tree;
          });
        },

        /**
         * Clear all package data for a notebook
         */
        clearNotebook: (notebookUri: NotebookId) => clearCache(notebookUri),

        /**
         * Stream of dependency tree changes.
         *
         * Emits the current value on subscription, then all subsequent changes.
         */
        streamDependencyTreeChanges:
          SubscriptionRef.changes(dependencyTreesRef),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(NotebookDocumentSessions.layer),
  );
}
