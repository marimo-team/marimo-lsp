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
import { SandboxController } from "../SandboxController.ts";

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
      const sandboxController = yield* SandboxController;

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
        setPackageListError(notebookUri: NotebookUri, error: string) {
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
        setDependencyTreeError(notebookUri: NotebookUri, error: string) {
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

            yield* Log.error("Dependency tree error", { notebookUri, error });
          });
        },

        /**
         * Get package list state for a notebook
         */
        getPackageList(notebookUri: NotebookUri) {
          return Effect.map(
            SubscriptionRef.get(packageListsRef),
            HashMap.get(notebookUri),
          );
        },

        /**
         * Get dependency tree state for a notebook
         */
        getDependencyTree(notebookUri: NotebookUri) {
          return Effect.map(
            SubscriptionRef.get(dependencyTreesRef),
            HashMap.get(notebookUri),
          );
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
              Option.isSome(existing) &&
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

            const controller = Option.getOrElse(
              yield* controllers.getActiveController(
                activeNotebookEditor.value.notebook,
              ),
              // fallback to sandbox
              () => sandboxController,
            );

            let executable: string;
            if ("executable" in controller) {
              executable = controller.executable;
            } else {
              yield* Log.warn(
                "No active controller for fetching dependency tree",
              );
              return null;
            }

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
                  method: "get_dependency_tree",
                  params: {
                    notebookUri,
                    executable,
                    inner: {},
                  },
                },
              })
              .pipe(
                Effect.tap((result) =>
                  Log.trace("Fetched dependency tree", {
                    notebookUri,
                    result,
                  }),
                ),
                Effect.flatMap((raw) =>
                  Schema.decodeUnknown(DependencyTreeResponse)(raw),
                ),
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
                        command: "marimo.api",
                        params: {
                          method: "get_package_list",
                          params: {
                            notebookUri,
                            executable,
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
            yield* SubscriptionRef.update(
              packageListsRef,
              HashMap.remove(notebookUri),
            );
            yield* SubscriptionRef.update(
              dependencyTreesRef,
              HashMap.remove(notebookUri),
            );
            yield* Log.trace("Cleared package data", { notebookUri });
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
