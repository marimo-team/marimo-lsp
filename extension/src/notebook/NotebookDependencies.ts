import {
  Cache,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Stream,
  SubscriptionRef,
} from "effect";

import * as NotebookRuntime from "../kernel/NotebookRuntime.ts";
import * as MarimoClient from "../lsp/MarimoClient.ts";
import type {
  DependencyTreeNode,
  ScriptSource,
  VenvSource,
} from "../schemas/Models.gen.ts";
import * as NotebookSession from "./NotebookSession.ts";

export type State = Data.TaggedEnum<{
  Idle: {};
  Loading: {};
  Loaded: { readonly tree: DependencyTreeNode | null };
  Failed: { readonly error: string };
}>;
export const State = Data.taggedEnum<State>();

export interface Interface {
  readonly changes: Stream.Stream<State>;
  readonly refresh: Effect.Effect<void>;
}

type PackageSource = VenvSource | ScriptSource;

function controllerSource(
  controller: NotebookRuntime.NotebookController,
): PackageSource {
  return typeof controller.executable === "string"
    ? { kind: "venv", executable: controller.executable }
    : { kind: "script" };
}

/** Dependency state and loading policy for one notebook document session. */
export class Service extends Context.Service<Service, Interface>()(
  "@marimo/NotebookDependencies",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const marimo = yield* MarimoClient.Service;
    const notebooks = yield* NotebookRuntime.Service;
    const session = yield* NotebookSession.Service;
    const generation = yield* Ref.make(0);
    const state = yield* SubscriptionRef.make<State>(State.Idle());

    const fetch = Effect.gen(function* () {
      yield* SubscriptionRef.set(state, State.Loading());
      const notebook = yield* notebooks.forNotebook(session.notebookId);
      const controller = yield* notebook.getController;
      if (Option.isNone(controller)) {
        return State.Failed({
          error: "No kernel selected",
        });
      }

      const source = controllerSource(controller.value);
      const result = yield* marimo
        .getDependencyTree({
          notebookUri: session.notebookId,
          source,
        })
        .pipe(
          Effect.map(({ tree }) => State.Loaded({ tree })),
          Effect.catch((error) => {
            const message = String(error);
            if (source.kind === "script") {
              return Effect.logError(
                "Dependency tree failed for script mode",
              ).pipe(
                Effect.annotateLogs({
                  notebookUri: session.notebookId,
                  error: message,
                }),
                Effect.as(State.Failed({ error: message })),
              );
            }

            return Effect.logWarning(
              "Dependency tree failed, falling back to package list",
            ).pipe(
              Effect.annotateLogs({
                notebookUri: session.notebookId,
                error: message,
              }),
              Effect.andThen(
                marimo
                  .listPackages({
                    notebookUri: session.notebookId,
                    source,
                  })
                  .pipe(
                    Effect.map((packageList) =>
                      State.Loaded({
                        tree: {
                          name: "installed-packages",
                          version: null,
                          tags: [],
                          dependencies: packageList.packages.map((pkg) => ({
                            name: pkg.name,
                            version: pkg.version,
                            tags: [],
                            dependencies: [],
                          })),
                        },
                      }),
                    ),
                    Effect.catch((fallbackError) => {
                      const fallbackMessage = String(fallbackError);
                      return Effect.logError(
                        "Package list fallback also failed",
                      ).pipe(
                        Effect.annotateLogs({
                          notebookUri: session.notebookId,
                          error: fallbackMessage,
                        }),
                        Effect.as(
                          State.Failed({
                            error: `${message}; fallback also failed: ${fallbackMessage}`,
                          }),
                        ),
                      );
                    }),
                  ),
              ),
            );
          }),
        );

      yield* Effect.logTrace("Fetched notebook dependencies").pipe(
        Effect.annotateLogs({
          notebookUri: session.notebookId,
          state: result._tag,
        }),
      );
      return result;
    });

    const cache = yield* Cache.makeWith(() => fetch, {
      capacity: 1,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) &&
        exit.value._tag === "Loaded" &&
        exit.value.tree !== null
          ? Duration.infinity
          : Duration.zero,
    });

    const load = Effect.gen(function* () {
      const expectedGeneration = yield* Ref.get(generation);
      const result = yield* Cache.get(cache, expectedGeneration);
      if ((yield* Ref.get(generation)) === expectedGeneration) {
        yield* SubscriptionRef.set(state, result);
      }
      return result;
    });

    const invalidate = Ref.update(generation, (value) => value + 1).pipe(
      Effect.andThen(SubscriptionRef.set(state, State.Idle())),
    );

    return Service.of({
      changes: Stream.merge(
        SubscriptionRef.changes(state),
        Stream.fromEffect(load).pipe(Stream.drain),
      ),
      refresh: invalidate.pipe(Effect.andThen(load), Effect.asVoid),
    });
  }),
);
