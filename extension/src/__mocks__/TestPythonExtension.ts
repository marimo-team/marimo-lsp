import { Effect, Layer } from "effect";
import { PythonExtension } from "../services/PythonExtension.ts";

export const TestPythonExtensionLive = Layer.succeed(
  PythonExtension,
  PythonExtension.make({
    getKnownEnvironments() {
      return [];
    },
    onDidChangeEnvironments() {
      return Effect.acquireRelease(
        Effect.succeed({ dispose: () => {} }),
        (disposable) => Effect.sync(() => disposable.dispose()),
      );
    },
  }),
);
