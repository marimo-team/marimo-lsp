import * as py from "@vscode/python-extension";
import { Effect, Option, Stream } from "effect";

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
            Effect.acquireRelease(
              Effect.sync(() =>
                api.environments.onDidChangeEnvironments((evt) =>
                  emit.single(evt),
                ),
              ),
              (disposable) => Effect.sync(() => disposable.dispose()),
            ),
          );
        },
        activeEnvironmentPathChanges() {
          return Stream.asyncPush<py.ActiveEnvironmentPathChangeEvent>((emit) =>
            Effect.acquireRelease(
              Effect.sync(() =>
                api.environments.onDidChangeActiveEnvironmentPath((evt) =>
                  emit.single(evt),
                ),
              ),
              (disposable) => Effect.sync(() => disposable.dispose()),
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
