import * as py from "@vscode/python-extension";
import { Effect, Stream } from "effect";

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
      };
    }),
  },
) {}
