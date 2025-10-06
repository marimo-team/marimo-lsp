import type * as py from "@vscode/python-extension";
import { Data, Effect, HashSet, Layer, PubSub, Ref, Stream } from "effect";
import { PythonExtension } from "../services/PythonExtension.ts";

export class TestPythonExtension extends Data.TaggedClass(
  "TestPythonExtension",
)<{
  readonly layer: Layer.Layer<PythonExtension>;
}> {
  static make = Effect.fnUntraced(function* (envs: Array<py.Environment> = []) {
    const pubsub = yield* PubSub.unbounded<py.EnvironmentsChangeEvent>();
    const changes = Stream.fromPubSub(pubsub);

    const known = yield* Ref.make(HashSet.make(...envs));
    yield* Effect.forkScoped(
      changes.pipe(
        Stream.mapEffect((change) =>
          Ref.update(known, (set) =>
            change.type === "remove"
              ? HashSet.remove(set, change.env)
              : HashSet.add(set, change.env),
          ),
        ),
        Stream.runDrain,
      ),
    );

    return new TestPythonExtension({
      layer: Layer.scoped(
        PythonExtension,
        Effect.gen(function* () {
          return PythonExtension.make({
            knownEnvironments() {
              return Effect.map(Ref.get(known), (set) => HashSet.toValues(set));
            },
            environmentChanges() {
              return changes;
            },
          });
        }),
      ),
    });
  });

  static Default = TestPythonExtension.make([]).pipe(
    Effect.map((py) => py.layer),
    Effect.scoped,
    Layer.unwrapEffect,
  );
}
