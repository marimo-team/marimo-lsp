import * as py from "@vscode/python-extension";
import { Effect, Option, Stream } from "effect";

import { acquireDisposable } from "../utils/acquireDisposable.ts";

/**
 * Provides access to the VS Code Python extension API for
 * querying and managing Python environments.
 */
export class PythonExtension extends Effect.Service<PythonExtension>()(
  "PythonExtension",
  {
    scoped: Effect.gen(function* () {
      const api = yield* Effect.promise(() => py.PythonExtension.api());

      return {
        updateActiveEnvironmentPath(executable: string) {
          return Effect.promise(() =>
            api.environments.updateActiveEnvironmentPath(executable),
          );
        },
        knownEnvironments() {
          return Effect.succeed(api.environments.known);
        },
        environmentChanges() {
          return Stream.asyncPush<py.EnvironmentsChangeEvent>((emit) =>
            acquireDisposable(() =>
              api.environments.onDidChangeEnvironments((evt) =>
                emit.single(evt),
              ),
            ),
          );
        },
        activeEnvironmentPathChanges() {
          return Stream.asyncPush<py.ActiveEnvironmentPathChangeEvent>((emit) =>
            acquireDisposable(() =>
              api.environments.onDidChangeActiveEnvironmentPath((evt) =>
                emit.single(evt),
              ),
            ),
          );
        },
        getActiveEnvironmentPath(resource?: py.Resource) {
          return Effect.sync(() =>
            api.environments.getActiveEnvironmentPath(resource),
          );
        },
        resolveEnvironment(path: string | py.EnvironmentPath) {
          return Effect.promise(() =>
            api.environments.resolveEnvironment(path),
          ).pipe(Effect.map(Option.fromNullable));
        },
      };
    }),
  },
) {}
