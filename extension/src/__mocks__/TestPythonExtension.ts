import type * as py from "@vscode/python-extension";

import {
  Data,
  Effect,
  HashSet,
  Layer,
  Option,
  PubSub,
  Ref,
  Stream,
} from "effect";

import { Uri } from "../__mocks__/TestVsCode.ts";
import { PythonExtension } from "../services/PythonExtension.ts";

export class TestPythonExtension extends Data.TaggedClass(
  "TestPythonExtension",
)<{
  readonly layer: Layer.Layer<PythonExtension>;
  readonly addEnvironment: (env: py.ResolvedEnvironment) => Effect.Effect<void>;
  readonly removeEnvironment: (
    env: py.ResolvedEnvironment,
  ) => Effect.Effect<void>;
}> {
  static makeGlobalEnv(path: string): py.ResolvedEnvironment {
    return {
      id: path,
      path,
      environment: undefined,
      tools: [],
      version: undefined,
      executable: {
        uri: undefined,
        bitness: "Unknown",
        sysPrefix: "/usr/local/envs/blah/.venv",
      },
    };
  }
  static makeVenv(venvPath: string): py.ResolvedEnvironment {
    const env = TestPythonExtension.makeGlobalEnv(venvPath);
    return {
      ...env,
      environment: {
        type: "VirtualEnv",
        name: undefined,
        folderUri: Uri.file(venvPath),
        workspaceFolder: undefined,
      },
    };
  }
  static make = Effect.fnUntraced(function* (
    envs: Array<py.ResolvedEnvironment> = [],
  ) {
    const known = yield* Ref.make(HashSet.make(...envs));
    const pubsub = yield* PubSub.unbounded<py.EnvironmentsChangeEvent>();
    const activePathPubsub =
      yield* PubSub.unbounded<py.ActiveEnvironmentPathChangeEvent>();
    const activeEnv = yield* Ref.make<py.EnvironmentPath>({
      id: envs[0]?.id || "",
      path: envs[0]?.path || "",
    });

    return new TestPythonExtension({
      layer: Layer.succeed(
        PythonExtension,
        PythonExtension.make({
          updateActiveEnvironmentPath(executable: string) {
            return Effect.gen(function* () {
              const envPath: py.EnvironmentPath = {
                id: executable,
                path: executable,
              };
              yield* Ref.set(activeEnv, envPath);
              yield* activePathPubsub.publish({
                ...envPath,
                resource: undefined,
              });
            });
          },
          knownEnvironments() {
            return Effect.map(Ref.get(known), (set) => HashSet.toValues(set));
          },
          environmentChanges() {
            return Stream.fromPubSub(pubsub);
          },
          activeEnvironmentPathChanges() {
            return Stream.fromPubSub(activePathPubsub);
          },
          getActiveEnvironmentPath(_resource?: py.Resource) {
            return Ref.get(activeEnv);
          },
          resolveEnvironment(path: string | py.EnvironmentPath) {
            return Effect.gen(function* () {
              const pathStr = typeof path === "string" ? path : path.path;
              const knownSet = yield* Ref.get(known);
              return Option.fromNullable(
                Array.from(knownSet).find((e) => e.path === pathStr),
              );
            });
          },
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
