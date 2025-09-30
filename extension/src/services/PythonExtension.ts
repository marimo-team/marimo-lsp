import { PythonExtension as VsCodePythonExtension } from "@vscode/python-extension";
import { Effect } from "effect";

/**
 * Provides access to the VS Code Python extension API for
 * querying and managing Python environments.
 */
export class PythonExtension extends Effect.Service<PythonExtension>()(
  "PythonExtension",
  {
    effect: Effect.gen(function* () {
      const api = yield* Effect.promise(() => VsCodePythonExtension.api());
      return {
        get environments() {
          return api.environments;
        },
      };
    }).pipe(Effect.annotateLogs("service", "PythonExtension")),
  },
) {}
