import { Effect, HashMap, Option, Schema, SubscriptionRef } from "effect";
import {
  type DependencyTreeNode,
  DependencyTreeResponse,
  ListPackagesResponse,
  type PackageDescription,
} from "../../schemas.ts";
import type { NotebookUri } from "../../types.ts";
import { Log } from "../../utils/log.ts";
import { ControllerRegistry } from "../ControllerRegistry.ts";
import { LanguageClient } from "../LanguageClient.ts";
import { NotebookEditorRegistry } from "../NotebookEditorRegistry.ts";
import { VsCode } from "../VsCode.ts";

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
        HashMap.empty<NotebookUri, PackageListState>(),
      );

      // Track dependency trees: NotebookUri -> DependencyTreeState
      const dependencyTreesRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookUri, DependencyTreeState>(),
      );

      return {
        /**
         * Update package list for a notebook
         */
        updatePackageList(
          notebookUri: NotebookUri,
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

            yield* Log.trace("Updated package list", {
              notebookUri,
              count: packages.length,
            });
          });
        },

        /**
         * Set package list loading state
         */
        setPackageListLoading(notebookUri: NotebookUri, loading: boolean) {
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(packageListsRef, (map) => {
              const existing = HashMap.get(map, notebookUri);
              const state: PackageListState =
                existing._tag === "Some"
                  ? { ...existing.value, loading }
                  : { packages: [], loading, error: null };
              return HashMap.set(map, notebookUri, state);
            });
          });
        },

        /**
         * Set package list error state
         */
        setPackageListError(notebookUri: NotebookUri, error: string) {
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(packageListsRef, (map) => {
              const existing = HashMap.get(map, notebookUri);
              const state: PackageListState =
                existing._tag === "Some"
                  ? { ...existing.value, loading: false, error }
                  : { packages: [], loading: false, error };
              return HashMap.set(map, notebookUri, state);
            });

            yield* Log.error("Package list error", { notebookUri, error });
          });
        },

        /**
         * Update dependency tree for a notebook
         */
        updateDependencyTree(
          notebookUri: NotebookUri,
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

            yield* Log.trace("Updated dependency tree", {
              notebookUri,
              hasTree: tree !== null,
            });
          });
        },

        /**
         * Set dependency tree loading state
         */
        setDependencyTreeLoading(notebookUri: NotebookUri, loading: boolean) {
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(dependencyTreesRef, (map) => {
              const existing = HashMap.get(map, notebookUri);
              const state: DependencyTreeState =
                existing._tag === "Some"
                  ? { ...existing.value, loading }
                  : { tree: null, loading, error: null };
              return HashMap.set(map, notebookUri, state);
            });
          });
        },

        /**
         * Set dependency tree error state
         */
        setDependencyTreeError(notebookUri: NotebookUri, error: string) {
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(dependencyTreesRef, (map) => {
              const existing = HashMap.get(map, notebookUri);
              const state: DependencyTreeState =
                existing._tag === "Some"
                  ? { ...existing.value, loading: false, error }
                  : { tree: null, loading: false, error };
              return HashMap.set(map, notebookUri, state);
            });

            yield* Log.error("Dependency tree error", { notebookUri, error });
          });
        },

        /**
         * Get package list state for a notebook
         */
        getPackageList(notebookUri: NotebookUri) {
          return Effect.gen(function* () {
            const map = yield* SubscriptionRef.get(packageListsRef);
            return HashMap.get(map, notebookUri);
          });
        },

        /**
         * Get dependency tree state for a notebook
         */
        getDependencyTree(notebookUri: NotebookUri) {
          return Effect.gen(function* () {
            const map = yield* SubscriptionRef.get(dependencyTreesRef);
            return HashMap.get(map, notebookUri);
          });
        },

        /**
         * Fetch dependency tree from the language server
         * Caches the result in dependencyTreesRef and re-uses if already cached
         */
        fetchDependencyTree(notebookUri: NotebookUri) {
          return Effect.gen(function* () {
            // Check if we already have a cached tree
            const cached = yield* SubscriptionRef.get(dependencyTreesRef);
            const existing = HashMap.get(cached, notebookUri);

            // If we have a tree and it's not in error state, re-use it
            if (
              existing._tag === "Some" &&
              existing.value.tree &&
              !existing.value.error
            ) {
              yield* Log.trace("Re-using cached dependency tree", {
                notebookUri,
              });
              return existing.value.tree;
            }

            // Get the executable from the active controller
            const activeNotebookEditor =
              yield* editors.getActiveNotebookEditor();
            if (Option.isNone(activeNotebookEditor)) {
              yield* Log.warn("Could not find notebook editor");
              return null;
            }

            const controller = yield* controllers.getActiveController(
              activeNotebookEditor.value.notebook,
            );
            if (Option.isNone(controller)) {
              yield* Log.warn(
                "No active controller for fetching dependency tree",
              );
              return null;
            }

            const executable = controller.value.env.path;

            // Set loading state
            yield* SubscriptionRef.update(dependencyTreesRef, (map) => {
              const current = HashMap.get(map, notebookUri);
              const state: DependencyTreeState =
                current._tag === "Some"
                  ? { ...current.value, loading: true }
                  : { tree: null, loading: true, error: null };
              return HashMap.set(map, notebookUri, state);
            });

            // Fetch from language server
            const rawResult = yield* client
              .executeCommand({
                command: "marimo.get_dependency_tree",
                params: {
                  notebookUri,
                  executable,
                  inner: {},
                },
              })
              .pipe(
                Effect.tap((result) =>
                  Log.trace("Fetched dependency tree", {
                    notebookUri,
                    result,
                  }),
                ),
              )
              .pipe(
                Effect.flatMap((raw) =>
                  Schema.decodeUnknown(DependencyTreeResponse)(raw),
                ),
              )
              .pipe(
                Effect.catchAll((error) =>
                  Effect.gen(function* () {
                    const errorMsg = String(error);
                    yield* Log.warn(
                      "Dependency tree failed, falling back to package list",
                      {
                        notebookUri,
                        error: errorMsg,
                      },
                    );

                    // Fallback: fetch package list and convert to flat tree
                    const packageListRaw = yield* client
                      .executeCommand({
                        command: "marimo.get_package_list",
                        params: {
                          notebookUri,
                          executable,
                          inner: {},
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
                            yield* Log.error(
                              "Package list fallback also failed",
                              {
                                notebookUri,
                                error: fallbackErrorMsg,
                              },
                            );
                            return { packages: [] };
                          }),
                        ),
                      );

                    const packageListResult =
                      yield* Schema.decodeUnknown(ListPackagesResponse)(
                        packageListRaw,
                      );

                    // Convert flat package list to flat tree
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

            yield* Log.trace("Fetched and cached dependency tree", {
              notebookUri,
              hasTree: rawResult.tree !== null,
            });

            return rawResult.tree;
          });
        },

        /**
         * Clear all package data for a notebook
         */
        clearNotebook(notebookUri: NotebookUri) {
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(packageListsRef, (map) =>
              HashMap.remove(map, notebookUri),
            );
            yield* SubscriptionRef.update(dependencyTreesRef, (map) =>
              HashMap.remove(map, notebookUri),
            );

            yield* Log.trace("Cleared package data", { notebookUri });
          });
        },

        /**
         * Stream of package list changes
         */
        streamPackageListChanges() {
          return packageListsRef.changes;
        },

        /**
         * Stream of dependency tree changes
         */
        streamDependencyTreeChanges() {
          return dependencyTreesRef.changes;
        },
      };
    }),
  },
) {}
