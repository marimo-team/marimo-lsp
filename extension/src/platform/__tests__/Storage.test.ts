import { assert, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Result, Schema } from "effect";

import { Memento } from "../../__mocks__/TestExtensionContext.ts";
import { TestVsCode, Uri } from "../../__mocks__/TestVsCode.ts";
import * as ExtensionContext from "../ExtensionContext.ts";
import * as Storage from "../Storage.ts";

const withTestCtx = Effect.fn(function* (
  ctx: { globalState?: Memento; workspaceState?: Memento } = {},
) {
  const vscode = yield* TestVsCode.make();
  const layer = Layer.empty.pipe(
    Layer.provideMerge(Storage.layer),
    Layer.provide(TestVsCode.layer),
    Layer.provideMerge(
      Layer.succeed(ExtensionContext.Service, {
        globalState: ctx.globalState ?? new Memento(),
        workspaceState: ctx.workspaceState ?? new Memento(),
        extensionUri: Uri.parse("file:///test/extension/path", true),
        globalStorageUri: Uri.parse("file:///test/extension/path/libs", true),
      }),
    ),
  );
  return {
    key: Storage.createStorageKey("key", Schema.Struct({ value: Schema.Int })),
    layer,
    vscode,
  };
});

it.effect(
  "should return Option.None when no entry",
  Effect.fn(function* () {
    const { key, layer } = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service;
      const value = yield* storage.workspace.get(key);
      assert(Option.isOption(value));
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "should fallback to default without updating storage",
  Effect.fn(function* () {
    const { key, layer } = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service;
      const defaultValue = { value: 1 };

      const value = yield* storage.workspace.getWithDefault(key, defaultValue);
      expect(value).toEqual(defaultValue);

      const context = yield* ExtensionContext.Service;
      expect(context).toMatchInlineSnapshot(`
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
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "should encode value into the underlying store",
  Effect.fn(function* () {
    const { key, layer } = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service;
      yield* storage.workspace.set(key, { value: 2 });

      const context = yield* ExtensionContext.Service;
      expect(context).toMatchInlineSnapshot(`
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
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "should replace existing value in the underlying store",
  Effect.fn(function* () {
    // initial state
    const workspaceState = new Memento();
    yield* Effect.promise(() => workspaceState.update("key", { value: 2 }));

    const { key, layer } = yield* withTestCtx({ workspaceState });

    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service;
      yield* storage.workspace.set(key, { value: 3 });

      const context = yield* ExtensionContext.Service;
      expect(context).toMatchInlineSnapshot(`
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
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "should return DecodeError for a badly encoded value",
  Effect.fn(function* () {
    const workspaceState = new Memento();
    yield* Effect.promise(() => workspaceState.update("key", "blah"));

    const { key, layer } = yield* withTestCtx({ workspaceState });

    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service;
      const result = yield* Effect.result(storage.workspace.get(key));

      assert(Result.isFailure(result), "Expected to fail decoding");
      assert(result.failure._tag === "Storage.DecodeError");
    }).pipe(Effect.provide(layer));
  }),
);
