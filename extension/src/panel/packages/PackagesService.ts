import {
  Cache,
  Context,
  Effect,
  HashMap,
  Layer,
  Option,
  Result,
  Scope,
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

type DependencyTreeCacheKey = readonly [
  notebookId: NotebookId,
  sessionId: NotebookDocumentSession["id"],
];

const keyFor = (session: NotebookDocumentSession): DependencyTreeCacheKey => [
  session.notebookId,
  session.id,
];

/**
 * Manages dependency trees for notebooks.
 *
 * Caches dependency-tree lookups by document session. A SubscriptionRef keeps
 * the loading and result projection consumed by the packages view.
 */
export class PackagesService extends Context.Service<PackagesService>()(
  "PackagesService",
  {
    make: Effect.gen(function* () {
      const marimo = yield* MarimoClient;
      const notebooks = yield* NotebookRuntime;
      const editors = yield* NotebookEditorRegistry;
      const documentSessions = yield* NotebookDocumentSessions;

      const dependencyTreeProjection = yield* SubscriptionRef.make(
        HashMap.empty<DependencyTreeCacheKey, DependencyTreeState>(),
      );
      const projectLoading = (key: DependencyTreeCacheKey) =>
        SubscriptionRef.update(dependencyTreeProjection, (projection) =>
          HashMap.set(projection, key, {
            tree: null,
            loading: true,
            error: null,
          }),
        );

      const loadDependencyTree = (
        notebookUri: NotebookId,
        key?: DependencyTreeCacheKey,
      ) =>
        Effect.gen(function* () {
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

          const notebook = yield* notebooks.forNotebook(
            activeNotebook.value.id,
          );
          const activeController = yield* notebook.getController;
          if (Option.isNone(activeController)) {
            yield* Effect.logDebug(
              "No active controller; skipping dependency tree fetch",
            ).pipe(Effect.annotateLogs({ notebookUri }));
            return {
              tree: null,
              loading: false,
              error: "No kernel selected",
            } satisfies DependencyTreeState;
          }

          const source = controllerSource(activeController.value);
          if (key !== undefined) yield* projectLoading(key);

          return yield* marimo
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
                  ).pipe(Effect.annotateLogs({ notebookUri, error: errorMsg }));

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
        });

      const dependencyTreeCache = yield* Cache.make({
        capacity: Number.POSITIVE_INFINITY,
        lookup: (key: DependencyTreeCacheKey) =>
          // Cache starts its lookup fiber before publishing the entry. Yield
          // once so invalidation can always observe an in-flight request.
          Effect.yieldNow.pipe(Effect.andThen(loadDependencyTree(key[0], key))),
      });
      const projectCurrent = (key: DependencyTreeCacheKey) =>
        Effect.gen(function* () {
          const current = yield* Cache.getSuccess(dependencyTreeCache, key);
          yield* SubscriptionRef.update(
            dependencyTreeProjection,
            (projection) =>
              Option.match(current, {
                onNone: () => HashMap.remove(projection, key),
                onSome: (state) =>
                  state === null
                    ? HashMap.remove(projection, key)
                    : HashMap.set(projection, key, state),
              }),
          );
        });
      const clearCache = (
        notebookUri: NotebookId,
        expectedSession?: NotebookDocumentSession,
      ) =>
        Effect.gen(function* () {
          const keys: ReadonlyArray<DependencyTreeCacheKey> = expectedSession
            ? [keyFor(expectedSession)]
            : Array.from(yield* Cache.keys(dependencyTreeCache)).filter(
                ([cachedNotebookId]) => cachedNotebookId === notebookUri,
              );
          for (const key of keys) {
            yield* Cache.invalidate(dependencyTreeCache, key);
          }
          yield* SubscriptionRef.update(
            dependencyTreeProjection,
            (projection) =>
              expectedSession === undefined
                ? HashMap.filter(
                    projection,
                    (_, [cachedNotebookId]) => cachedNotebookId !== notebookUri,
                  )
                : HashMap.remove(projection, keyFor(expectedSession)),
          );
          yield* Effect.logTrace("Cleared package data").pipe(
            Effect.annotateLogs({ notebookUri }),
          );
        });

      const registeredSessionCleanups = new WeakSet<NotebookDocumentSession>();
      const registerSessionCleanup = Effect.fn(
        "PackagesService.registerSessionCleanup",
      )((session: NotebookDocumentSession) =>
        Effect.uninterruptible(
          Effect.suspend(() => {
            if (registeredSessionCleanups.has(session)) return Effect.void;
            registeredSessionCleanups.add(session);
            return Scope.addFinalizer(
              session.scope,
              clearCache(session.notebookId, session),
            );
          }),
        ),
      );

      return {
        /**
         * Get dependency tree state for a notebook
         */
        getDependencyTree(notebookUri: NotebookId) {
          const session = documentSessions.current(notebookUri);
          return session === undefined
            ? Effect.succeed(Option.none<DependencyTreeState>())
            : Effect.map(
                SubscriptionRef.get(dependencyTreeProjection),
                HashMap.get(keyFor(session)),
              );
        },

        /**
         * Fetch dependency tree from the language server
         * Re-uses successful results from dependencyTreeCache.
         */
        fetchDependencyTree(notebookUri: NotebookId) {
          return Effect.gen(function* () {
            const session = documentSessions.current(notebookUri);
            if (session === undefined) {
              return (yield* loadDependencyTree(notebookUri))?.tree ?? null;
            }

            const key = keyFor(session);
            yield* registerSessionCleanup(session);
            const existing = yield* Cache.getSuccess(dependencyTreeCache, key);
            if (
              Option.isSome(existing) &&
              existing.value !== null &&
              existing.value.tree !== null &&
              existing.value.error === null
            ) {
              yield* Effect.logTrace("Re-using cached dependency tree").pipe(
                Effect.annotateLogs({ notebookUri }),
              );
              return existing.value.tree;
            }
            if (Option.isSome(existing)) {
              yield* Cache.invalidate(dependencyTreeCache, key);
            }

            const next = yield* Cache.get(dependencyTreeCache, key);
            if (documentSessions.current(notebookUri) === session) {
              yield* projectCurrent(key);
            } else {
              yield* clearCache(notebookUri, session);
            }
            return next?.tree ?? null;
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
        streamDependencyTreeChanges: SubscriptionRef.changes(
          dependencyTreeProjection,
        ).pipe(
          Stream.map((projection) =>
            HashMap.filterMap(projection, (state, [notebookUri, sessionId]) =>
              documentSessions.current(notebookUri)?.id === sessionId
                ? Result.succeed(state)
                : Result.failVoid,
            ),
          ),
          Stream.changes,
        ),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(NotebookDocumentSessions.layer),
  );
}
