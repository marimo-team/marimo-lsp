import type * as py from "@vscode/python-extension";
import { Data, Effect, HashSet, Layer, PubSub, Ref, Stream } from "effect";
import { PythonExtension } from "../services/PythonExtension.ts";

export class TestPythonExtension extends Data.TaggedClass(
  "TestPythonExtension",
)<{
  readonly layer: Layer.Layer<PythonExtension>;
  readonly addEnvironment: (env: py.Environment) => Effect.Effect<void>;
  readonly removeEnvironment: (env: py.Environment) => Effect.Effect<void>;
}> {
  static makeEnv(venvPath: string): py.Environment {
    return {
      id: venvPath,
      path: venvPath,
      environment: undefined,
      tools: [],
      version: undefined,
      executable: {
        uri: undefined,
        bitness: undefined,
        sysPrefix: undefined,
      },
    };
  }
  static make = Effect.fnUntraced(function* (envs: Array<py.Environment> = []) {
    const known = yield* Ref.make(HashSet.make(...envs));
    const pubsub = yield* PubSub.unbounded<py.EnvironmentsChangeEvent>();

    return new TestPythonExtension({
      layer: Layer.scoped(
        PythonExtension,
        Effect.gen(function* () {
          return PythonExtension.make({
            knownEnvironments() {
              return Effect.map(Ref.get(known), (set) => HashSet.toValues(set));
            },
            environmentChanges() {
              return Stream.fromPubSub(pubsub);
            },
          });
        }),
      ),
      addEnvironment: (env) =>
        Effect.gen(function* () {
          yield* Ref.update(known, HashSet.add(env));
          yield* pubsub.publish({ type: "add", env });
        }),
      removeEnvironment: (env) =>
        Effect.gen(function* () {
          yield* Ref.update(known, HashSet.remove(env));
          yield* pubsub.publish({ type: "remove", env });
        }),
    });
  });

  static Default = TestPythonExtension.make([]).pipe(
    Effect.map((py) => py.layer),
    Effect.scoped,
    Layer.unwrapEffect,
  );
}
