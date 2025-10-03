import * as py from "@vscode/python-extension";
import { Effect, FiberSet } from "effect";

/**
 * Provides access to the VS Code Python extension API for
 * querying and managing Python environments.
 */
export class PythonExtension extends Effect.Service<PythonExtension>()(
  "PythonExtension",
  {
    scoped: Effect.gen(function* () {
      const api = yield* Effect.promise(() => py.PythonExtension.api());
      const runPromise = yield* FiberSet.makeRuntimePromise();
      return {
        getKnownEnvironments() {
          return api.environments.known;
        },
        onDidChangeEnvironments(
          factory: (
            e: py.EnvironmentsChangeEvent,
          ) => Effect.Effect<void, never, never>,
        ) {
          return Effect.acquireRelease(
            Effect.sync(() =>
              api.environments.onDidChangeEnvironments((evt) =>
                runPromise(factory(evt)),
              ),
            ),
            (disposable) => Effect.sync(() => disposable.dispose()),
          );
        },
      };
    }),
  },
) {}
