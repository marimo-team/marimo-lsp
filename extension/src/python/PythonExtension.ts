import * as py from "@vscode/python-extension";
import { Context, Effect, Layer, Option, Queue, Stream } from "effect";

import { acquireDisposable } from "../lib/acquireDisposable.ts";

/**
 * Provides access to the VS Code Python extension API for
 * querying and managing Python environments.
 */
export class PythonExtension extends Context.Service<PythonExtension>()(
  "PythonExtension",
  {
    make: Effect.gen(function* () {
      const api = yield* Effect.promise(() => py.PythonExtension.api());

      return {
        updateActiveEnvironmentPath(executable: string) {
          return Effect.promise(() =>
            api.environments.updateActiveEnvironmentPath(executable),
          );
        },
        knownEnvironments: Effect.sync(() => api.environments.known),
        environmentChanges: Stream.callback<py.EnvironmentsChangeEvent>(
          (queue) =>
            acquireDisposable(() =>
              api.environments.onDidChangeEnvironments((evt) => {
                Queue.offerUnsafe(queue, evt);
              }),
            ),
        ),
        activeEnvironmentPathChanges:
          Stream.callback<py.ActiveEnvironmentPathChangeEvent>((queue) =>
            acquireDisposable(() =>
              api.environments.onDidChangeActiveEnvironmentPath((evt) => {
                Queue.offerUnsafe(queue, evt);
              }),
            ),
          ),
        getActiveEnvironmentPath(resource?: py.Resource) {
          return Effect.sync(() =>
            api.environments.getActiveEnvironmentPath(resource),
          );
        },
        resolveEnvironment(path: string | py.EnvironmentPath) {
          return Effect.promise(() =>
            api.environments.resolveEnvironment(path),
          ).pipe(Effect.map(Option.fromNullishOr));
        },
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
