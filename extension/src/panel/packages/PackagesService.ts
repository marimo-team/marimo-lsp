import { Effect, HashMap, Option, Stream, SubscriptionRef } from "effect";

import {
  type NotebookController,
  NotebookRuntime,
} from "../../kernel/NotebookRuntime.ts";
import { MarimoClient } from "../../lsp/MarimoClient.ts";
import { NotebookEditorRegistry } from "../../notebook/NotebookEditorRegistry.ts";
import { VsCode } from "../../platform/VsCode.ts";
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
export class PackagesService extends Effect.Service<PackagesService>()(
  "PackagesService",
  {
    scoped: Effect.gen(function* () {
      const marimo = yield* MarimoClient;
      const notebooks = yield* NotebookRuntime;
      const editors = yield* NotebookEditorRegistry;
      const code = yield* VsCode;

      // Track dependency trees: NotebookUri -> DependencyTreeState
      const dependencyTreesRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, DependencyTreeState>(),
      );
      const sessionTokens = new Map<NotebookId, object>();

      const tokenFor = (notebookUri: NotebookId) => {
        const existing = sessionTokens.get(notebookUri);
        if (existing) return existing;
        const token = {};
        sessionTokens.set(notebookUri, token);
        return token;
      };

      const clearNotebook = (notebookUri: NotebookId) =>
        Effect.gen(function* () {
          sessionTokens.delete(notebookUri);
          yield* SubscriptionRef.update(
            dependencyTreesRef,
            HashMap.remove(notebookUri),
          );
          yield* Effect.logTrace("Cleared package data").pipe(
            Effect.annotateLogs({ notebookUri }),
          );
        });

      yield* Effect.forkScoped(
        code.workspace.notebookDocumentClosed().pipe(
          Stream.runForEach((document) =>
            Option.match(MarimoNotebookDocument.tryFrom(document), {
              onNone: () => Effect.void,
              onSome: (notebook) => clearNotebook(notebook.id),
            }),
          ),
        ),
      );

      return {
        /**
         * Set dependency tree loading state
         */
        setDependencyTreeLoading(notebookUri: NotebookId, loading: boolean) {
          return SubscriptionRef.update(dependencyTreesRef, (map) =>
            HashMap.set(
              map,
              notebookUri,
              Option.match(HashMap.get(map, notebookUri), {
                onNone: () => ({ tree: null, loading, error: null }),
                onSome: (value) => ({ ...value, loading }),
              }),
            ),
          );
        },

        /**
         * Set dependency tree error state
         */
        setDependencyTreeError(notebookUri: NotebookId, error: string) {
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(dependencyTreesRef, (map) =>
              HashMap.set(
                map,
                notebookUri,
                Option.match(HashMap.get(map, notebookUri), {
                  onSome: (value) => ({ ...value, loading: false, error }),
                  onNone: () => ({ tree: null, loading: false, error }),
                }),
              ),
            );

            yield* Effect.logError("Dependency tree error").pipe(
              Effect.annotateLogs({ notebookUri, error }),
            );
          });
        },

        /**
         * Get dependency tree state for a notebook
         */
        getDependencyTree(notebookUri: NotebookId) {
          return Effect.map(
            SubscriptionRef.get(dependencyTreesRef),
            HashMap.get(notebookUri),
          );
        },

        /**
         * Fetch dependency tree from the language server
         * Caches the result in dependencyTreesRef and re-uses if already cached
         */
        fetchDependencyTree(notebookUri: NotebookId) {
          return Effect.gen(function* () {
            const sessionToken = tokenFor(notebookUri);
            const updateIfCurrent = (
              update: (
                map: HashMap.HashMap<NotebookId, DependencyTreeState>,
              ) => HashMap.HashMap<NotebookId, DependencyTreeState>,
            ) =>
              sessionTokens.get(notebookUri) === sessionToken
                ? SubscriptionRef.update(dependencyTreesRef, update)
                : Effect.void;

            // Check if we already have a cached tree
            const cached = yield* SubscriptionRef.get(dependencyTreesRef);
            const existing = HashMap.get(cached, notebookUri);

            // If we have a tree and it's not in error state, re-use it
            if (
              Option.isSome(existing) &&
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
              yield* editors.getActiveNotebookEditor(),
              (editor) => MarimoNotebookDocument.tryFrom(editor.notebook),
            );
            if (Option.isNone(activeNotebook)) {
              yield* Effect.logWarning("Could not find marimo-notebook editor");
              return null;
            }

            const activeController = yield* notebooks
              .forNotebook(activeNotebook.value.id)
              .getController();
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

            // Set loading state
            yield* updateIfCurrent((map) =>
              HashMap.set(
                map,
                notebookUri,
                Option.match(HashMap.get(map, notebookUri), {
                  onNone: () => ({ tree: null, loading: true, error: null }),
                  onSome: (value) => ({ ...value, loading: true }),
                }),
              ),
            );

            // Fetch from language server
            const rawResult = yield* marimo
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
                Effect.catchAll((error) =>
                  Effect.gen(function* () {
                    const errorMsg = String(error);

                    // Script mode has no useful fallback — `uv tree --script`
                    // is the only path that resolves PEP 723 metadata.
                    if (source.kind === "script") {
                      yield* updateIfCurrent((map) =>
                        HashMap.set(map, notebookUri, {
                          tree: null,
                          loading: false,
                          error: errorMsg,
                        }),
                      );
                      yield* Effect.logError(
                        "Dependency tree failed for script mode",
                      ).pipe(
                        Effect.annotateLogs({ notebookUri, error: errorMsg }),
                      );
                      return { tree: null };
                    }

                    yield* Effect.logWarning(
                      "Dependency tree failed, falling back to package list",
                    ).pipe(
                      Effect.annotateLogs({ notebookUri, error: errorMsg }),
                    );

                    // Venv fallback: fetch the flat package list (which the
                    // server backs with `uv pip list -p <exe>`) and synthesize
                    // a single-level tree from it.
                    const packageListRaw = yield* marimo
                      .getPackageList({
                        notebookUri,
                        source,
                        inner: {},
                      })
                      .pipe(
                        Effect.catchAll((fallbackError) =>
                          Effect.gen(function* () {
                            const fallbackErrorMsg = String(fallbackError);
                            yield* updateIfCurrent((map) =>
                              HashMap.set(map, notebookUri, {
                                tree: null,
                                loading: false,
                                error: `${errorMsg}; fallback also failed: ${fallbackErrorMsg}`,
                              }),
                            );
                            yield* Effect.logError(
                              "Package list fallback also failed",
                            ).pipe(
                              Effect.annotateLogs({
                                notebookUri,
                                error: fallbackErrorMsg,
                              }),
                            );
                            return { packages: [] };
                          }),
                        ),
                      );

                    const flatTree: DependencyTreeNode = {
                      name: "installed-packages",
                      version: null,
                      tags: [],
                      dependencies: packageListRaw.packages.map((pkg) => ({
                        name: pkg.name,
                        version: pkg.version,
                        tags: [],
                        dependencies: [],
                      })),
                    };

                    return { tree: flatTree };
                  }),
                ),
              );

            if (sessionTokens.get(notebookUri) === sessionToken) {
              yield* SubscriptionRef.update(dependencyTreesRef, (map) =>
                HashMap.set(map, notebookUri, {
                  tree: rawResult.tree,
                  loading: false,
                  error: null,
                }),
              );
              yield* Effect.logTrace("Cached dependency tree").pipe(
                Effect.annotateLogs({
                  notebookUri,
                  hasTree: rawResult.tree !== null,
                }),
              );
            }

            return rawResult.tree;
          });
        },

        /**
         * Clear all package data for a notebook
         */
        clearNotebook,

        /**
         * Stream of dependency tree changes.
         *
         * Emits the current value on subscription, then all subsequent changes.
         */
        streamDependencyTreeChanges() {
          return dependencyTreesRef.changes;
        },
      };
    }),
  },
) {}
