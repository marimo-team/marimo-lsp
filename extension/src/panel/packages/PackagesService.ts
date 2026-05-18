import { Effect, HashMap, Option, Schema, SubscriptionRef } from "effect";

import { ControllerRegistry } from "../../kernel/ControllerRegistry.ts";
import { LanguageClient } from "../../lsp/LanguageClient.ts";
import { NotebookEditorRegistry } from "../../notebook/NotebookEditorRegistry.ts";
import { MarimoNotebookDocument } from "../../schemas/MarimoNotebookDocument.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import {
  type DependencyTreeNode,
  DependencyTreeResponse,
  ListPackagesResponse,
  type PackageDescription,
} from "./schemas.ts";

// Re-export schema types for convenience
export type { DependencyTreeNode };
export type PackageDescriptionType = Schema.Schema.Type<
  typeof PackageDescription
>;

interface PackageListState {
  packages: PackageDescriptionType[];
  loading: boolean;
  error: string | null;
}

interface DependencyTreeState {
  tree: DependencyTreeNode | null;
  loading: boolean;
  error: string | null;
}

/**
 * Manages package lists and dependency trees for notebooks.
 *
 * Stores:
 * 1. Package lists (NotebookUri -> PackageListState)
 * 2. Dependency trees (NotebookUri -> DependencyTreeState)
 *
 * Uses SubscriptionRef for reactive state management.
 */
export class PackagesService extends Effect.Service<PackagesService>()(
  "PackagesService",
  {
    scoped: Effect.gen(function* () {
      const client = yield* LanguageClient;
      const controllers = yield* ControllerRegistry;
      const editors = yield* NotebookEditorRegistry;

      // Track package lists: NotebookUri -> PackageListState
      const packageListsRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, PackageListState>(),
      );

      // Track dependency trees: NotebookUri -> DependencyTreeState
      const dependencyTreesRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, DependencyTreeState>(),
      );

      return {
        /**
         * Update package list for a notebook
         */
        updatePackageList(
          notebookUri: NotebookId,
          packages: PackageDescriptionType[],
        ) {
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(packageListsRef, (map) =>
              HashMap.set(map, notebookUri, {
                packages,
                loading: false,
                error: null,
              }),
            );

            yield* Effect.logTrace("Updated package list").pipe(
              Effect.annotateLogs({ notebookUri, count: packages.length }),
            );
          });
        },

        /**
         * Set package list loading state
         */
        setPackageListLoading(notebookUri: NotebookId, loading: boolean) {
          return SubscriptionRef.update(packageListsRef, (map) =>
            HashMap.set(
              map,
              notebookUri,
              Option.match(HashMap.get(map, notebookUri), {
                onSome: (value) => ({ ...value, loading }),
                onNone: () => ({ packages: [], loading, error: null }),
              }),
            ),
          );
        },

        /**
         * Set package list error state
         */
        setPackageListError(notebookUri: NotebookId, error: string) {
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(packageListsRef, (map) =>
              HashMap.set(
                map,
                notebookUri,
                Option.match(HashMap.get(map, notebookUri), {
                  onSome: (value) => ({ ...value, loading: false, error }),
                  onNone: () => ({ packages: [], loading: false, error }),
                }),
              ),
            );
            yield* Effect.logError("Package list error").pipe(
              Effect.annotateLogs({ notebookUri, error }),
            );
          });
        },

        /**
         * Update dependency tree for a notebook
         */
        updateDependencyTree(
          notebookUri: NotebookId,
          tree: DependencyTreeNode | null,
        ) {
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(dependencyTreesRef, (map) =>
              HashMap.set(map, notebookUri, {
                tree,
                loading: false,
                error: null,
              }),
            );

            yield* Effect.logTrace("Updated dependency tree").pipe(
              Effect.annotateLogs({ notebookUri, hasTree: tree !== null }),
            );
          });
        },

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
         * Get package list state for a notebook
         */
        getPackageList(notebookUri: NotebookId) {
          return Effect.map(
            SubscriptionRef.get(packageListsRef),
            HashMap.get(notebookUri),
          );
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

            const activeController = yield* controllers.getActiveController(
              activeNotebook.value,
            );
            if (Option.isNone(activeController)) {
              yield* SubscriptionRef.update(dependencyTreesRef, (map) =>
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

            const source = activeController.value.target;

            // Set loading state
            yield* SubscriptionRef.update(dependencyTreesRef, (map) =>
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
            const rawResult = yield* client
              .executeCommand({
                command: "marimo.api",
                params: {
                  method: "get-dependency-tree",
                  params: {
                    notebookUri,
                    source,
                    inner: {},
                  },
                },
              })
              .pipe(
                Effect.tap((result) =>
                  Effect.logTrace("Fetched dependency tree").pipe(
                    Effect.annotateLogs({ notebookUri, result }),
                  ),
                ),
                Effect.flatMap((raw) =>
                  Schema.decodeUnknown(DependencyTreeResponse)(raw),
                ),
                Effect.catchAll((error) =>
                  Effect.gen(function* () {
                    const errorMsg = String(error);

                    // Script mode has no useful fallback — `uv tree --script`
                    // is the only path that resolves PEP 723 metadata.
                    if (source.kind === "script") {
                      yield* SubscriptionRef.update(dependencyTreesRef, (map) =>
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
                    const packageListRaw = yield* client
                      .executeCommand({
                        command: "marimo.api",
                        params: {
                          method: "get-package-list",
                          params: {
                            notebookUri,
                            source,
                            inner: {},
                          },
                        },
                      })
                      .pipe(
                        Effect.catchAll((fallbackError) =>
                          Effect.gen(function* () {
                            const fallbackErrorMsg = String(fallbackError);
                            yield* SubscriptionRef.update(
                              dependencyTreesRef,
                              (map) =>
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

                    const packageListResult =
                      yield* Schema.decodeUnknown(ListPackagesResponse)(
                        packageListRaw,
                      );

                    const flatTree: DependencyTreeNode = {
                      name: "installed-packages",
                      version: null,
                      tags: [],
                      dependencies: packageListResult.packages.map((pkg) => ({
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

            // Update cache with result
            yield* SubscriptionRef.update(dependencyTreesRef, (map) =>
              HashMap.set(map, notebookUri, {
                tree: rawResult.tree,
                loading: false,
                error: null,
              }),
            );

            yield* Effect.logTrace("Fetched and cached dependency tree").pipe(
              Effect.annotateLogs({
                notebookUri,
                hasTree: rawResult.tree !== null,
              }),
            );

            return rawResult.tree;
          });
        },

        /**
         * Clear all package data for a notebook
         */
        clearNotebook(notebookUri: NotebookId) {
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(
              packageListsRef,
              HashMap.remove(notebookUri),
            );
            yield* SubscriptionRef.update(
              dependencyTreesRef,
              HashMap.remove(notebookUri),
            );
            yield* Effect.logTrace("Cleared package data").pipe(
              Effect.annotateLogs({ notebookUri }),
            );
          });
        },

        /**
         * Stream of package list changes.
         *
         * Emits the current value on subscription, then all subsequent changes.
         */
        streamPackageListChanges() {
          return packageListsRef.changes;
        },

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
