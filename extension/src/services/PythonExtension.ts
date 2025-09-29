import { PythonExtension as VsCodePythonExtension } from "@vscode/python-extension";
import { Effect } from "effect";

export class PythonExtension extends Effect.Service<PythonExtension>()(
  "PythonExtension",
  {
    effect: Effect.gen(function* () {
      const api = yield* Effect.promise(() => VsCodePythonExtension.api());
      return {
        environments: api.environments,
      };
    }),
  },
) {}
