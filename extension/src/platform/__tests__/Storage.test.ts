import * as Vitest from "@effect/vitest";
import { Effect, Layer, Option, Result, Schema } from "effect";

import { Memento } from "../../__mocks__/TestExtensionContext.ts";
import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import * as ExtensionContext from "../ExtensionContext.ts";
import * as Storage from "../Storage.ts";

const key = Storage.createStorageKey(
  "key",
  Schema.Struct({ value: Schema.Int }),
);

const layerWith = (
  workspaceEntries: ReadonlyArray<readonly [string, unknown]>,
) => {
  const contextLayer = Layer.effect(
    ExtensionContext.Service,
    Effect.gen(function* () {
      const workspaceState = new Memento();
      yield* Effect.forEach(workspaceEntries, ([entryKey, value]) =>
        Effect.promise(() => workspaceState.update(entryKey, value)),
      );

      return ExtensionContext.Service.of({
        globalState: new Memento(),
        workspaceState,
        extensionUri: TestVsCode.Uri.parse("file:///test/extension/path", true),
        globalStorageUri: TestVsCode.Uri.parse(
          "file:///test/extension/path/libs",
          true,
        ),
      });
    }),
  );

  return Storage.layer.pipe(Layer.provideMerge(contextLayer));
};

const it = EffectTest.make(layerWith([]));
const existingValueIt = EffectTest.make(layerWith([["key", { value: 2 }]]));
const badlyEncodedIt = EffectTest.make(layerWith([["key", "blah"]]));

it.effect(
  "should return Option.None when no entry",
  Effect.fn(function* () {
    const storage = yield* Storage.Service;
    const value = yield* storage.workspace.get(key);
    Vitest.assert(Option.isOption(value));
  }),
);

it.effect(
  "should fallback to default without updating storage",
  Effect.fn(function* () {
    const storage = yield* Storage.Service;
    const defaultValue = { value: 1 };

    const value = yield* storage.workspace.getWithDefault(key, defaultValue);
    Vitest.expect(value).toEqual(defaultValue);

    const context = yield* ExtensionContext.Service;
    Vitest.expect(context).toMatchInlineSnapshot(`
        {
          "extensionUri": {
            "authority": "",
            "fragment": "",
            "path": "/test/extension/path",
            "query": "",
            "scheme": "file",
          },
          "globalState": {},
          "globalStorageUri": {
            "authority": "",
            "fragment": "",
            "path": "/test/extension/path/libs",
            "query": "",
            "scheme": "file",
          },
          "workspaceState": {},
        }
      `);
  }),
);

it.effect(
  "should encode value into the underlying store",
  Effect.fn(function* () {
    const storage = yield* Storage.Service;
    yield* storage.workspace.set(key, { value: 2 });

    const context = yield* ExtensionContext.Service;
    Vitest.expect(context).toMatchInlineSnapshot(`
        {
          "extensionUri": {
            "authority": "",
            "fragment": "",
            "path": "/test/extension/path",
            "query": "",
            "scheme": "file",
          },
          "globalState": {},
          "globalStorageUri": {
            "authority": "",
            "fragment": "",
            "path": "/test/extension/path/libs",
            "query": "",
            "scheme": "file",
          },
          "workspaceState": {
            "key": {
              "value": 2,
            },
          },
        }
      `);
  }),
);

existingValueIt.effect(
  "should replace existing value in the underlying store",
  Effect.fn(function* () {
    const storage = yield* Storage.Service;
    yield* storage.workspace.set(key, { value: 3 });

    const context = yield* ExtensionContext.Service;
    Vitest.expect(context).toMatchInlineSnapshot(`
        {
          "extensionUri": {
            "authority": "",
            "fragment": "",
            "path": "/test/extension/path",
            "query": "",
            "scheme": "file",
          },
          "globalState": {},
          "globalStorageUri": {
            "authority": "",
            "fragment": "",
            "path": "/test/extension/path/libs",
            "query": "",
            "scheme": "file",
          },
          "workspaceState": {
            "key": {
              "value": 3,
            },
          },
        }
      `);
  }),
);

badlyEncodedIt.effect(
  "should return DecodeError for a badly encoded value",
  Effect.fn(function* () {
    const storage = yield* Storage.Service;
    const result = yield* Effect.result(storage.workspace.get(key));

    Vitest.assert(Result.isFailure(result), "Expected to fail decoding");
    Vitest.assert(result.failure._tag === "Storage.DecodeError");
  }),
);
