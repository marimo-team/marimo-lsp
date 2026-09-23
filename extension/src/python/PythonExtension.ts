import * as py from "@vscode/python-extension";
import { Context, Effect, Layer, Option, Queue, Stream } from "effect";

import { acquireDisposable } from "../lib/acquireDisposable.ts";

/**
 * Provides access to the VS Code Python extension API for
 * querying and managing Python environments.
 */
export interface Interface {
  readonly updateActiveEnvironmentPath: (
    executable: string,
  ) => Effect.Effect<void>;
  readonly knownEnvironments: Effect.Effect<ReadonlyArray<py.Environment>>;
  readonly environmentChanges: Stream.Stream<py.EnvironmentsChangeEvent>;
  readonly activeEnvironmentPathChanges: Stream.Stream<py.ActiveEnvironmentPathChangeEvent>;
  readonly getActiveEnvironmentPath: (
    resource?: py.Resource,
  ) => Effect.Effect<py.EnvironmentPath>;
  readonly resolveEnvironment: (
    path: string | py.EnvironmentPath,
  ) => Effect.Effect<Option.Option<py.ResolvedEnvironment>>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/PythonExtension",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const api = yield* Effect.promise(() => py.PythonExtension.api());

    const updateActiveEnvironmentPath = Effect.fn(
      "PythonExtension.updateActiveEnvironmentPath",
    )(function* (executable: string) {
      yield* Effect.promise(() =>
        api.environments.updateActiveEnvironmentPath(executable),
      );
    });

    const knownEnvironments = Effect.sync(() => api.environments.known);

    const environmentChanges = Stream.callback<py.EnvironmentsChangeEvent>(
      (queue) =>
        acquireDisposable(() =>
          api.environments.onDidChangeEnvironments((event) => {
            Queue.offerUnsafe(queue, event);
          }),
        ),
    );

    const activeEnvironmentPathChanges =
      Stream.callback<py.ActiveEnvironmentPathChangeEvent>((queue) =>
        acquireDisposable(() =>
          api.environments.onDidChangeActiveEnvironmentPath((event) => {
            Queue.offerUnsafe(queue, event);
          }),
        ),
      );

    const getActiveEnvironmentPath = Effect.fn(
      "PythonExtension.getActiveEnvironmentPath",
    )(function* (resource?: py.Resource) {
      return yield* Effect.sync(() =>
        api.environments.getActiveEnvironmentPath(resource),
      );
    });

    const resolveEnvironment = Effect.fn("PythonExtension.resolveEnvironment")(
      function* (path: string | py.EnvironmentPath) {
        return Option.fromNullishOr(
          yield* Effect.promise(() =>
            api.environments.resolveEnvironment(path),
          ),
        );
      },
    );

    return Service.of({
      updateActiveEnvironmentPath,
      knownEnvironments,
      environmentChanges,
      activeEnvironmentPathChanges,
      getActiveEnvironmentPath,
      resolveEnvironment,
    });
  }),
);
