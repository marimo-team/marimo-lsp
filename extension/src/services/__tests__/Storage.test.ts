import { assert, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { Memento } from "../../__mocks__/TestExtensionContext.ts";
import { TestVsCode, Uri } from "../../__mocks__/TestVsCode.ts";
import {
  createStorageKey,
  ExtensionContext,
  Storage,
} from "../../services/Storage.ts";

const withTestCtx = Effect.fnUntraced(function* (
  ctx: { globalState?: Memento; workspaceState?: Memento } = {},
) {
  const vscode = yield* TestVsCode.make();
  const layer = Layer.empty.pipe(
    Layer.provideMerge(Storage.Default),
    Layer.provide(TestVsCode.Default),
    Layer.provideMerge(
      Layer.succeed(ExtensionContext, {
        globalState: ctx.globalState ?? new Memento(),
        workspaceState: ctx.workspaceState ?? new Memento(),
        extensionUri: Uri.parse("file:///test/extension/path", true),
      }),
    ),
  );
  return {
    key: createStorageKey("key", Schema.Struct({ value: Schema.Int })),
    layer,
    vscode,
  };
});

it.effect(
  "should return Option.None when no entry",
  Effect.fnUntraced(function* () {
    const { key, layer } = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const storage = yield* Storage;
      const value = yield* storage.workspace.get(key);
      assert(Option.isOption(value));
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "should fallback to default without updating storage",
  Effect.fnUntraced(function* () {
    const { key, layer } = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const storage = yield* Storage;
      const defaultValue = { value: 1 };

      const value = yield* storage.workspace.getWithDefault(key, defaultValue);
      expect(value).toEqual(defaultValue);

      const context = yield* ExtensionContext;
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
          "workspaceState": {},
        }
      `);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "should encode value into the underlying store",
  Effect.fnUntraced(function* () {
    const { key, layer } = yield* withTestCtx();
    yield* Effect.gen(function* () {
      const storage = yield* Storage;
      yield* storage.workspace.set(key, { value: 2 });

      const context = yield* ExtensionContext;
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
  Effect.fnUntraced(function* () {
    // initial state
    const workspaceState = new Memento();
    workspaceState.update("key", { value: 2 });

    const { key, layer } = yield* withTestCtx({ workspaceState });

    yield* Effect.gen(function* () {
      const storage = yield* Storage;
      yield* storage.workspace.set(key, { value: 3 });

      const context = yield* ExtensionContext;
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
  "should throw StorageDecodeError badly encoded value",
  Effect.fnUntraced(function* () {
    const workspaceState = new Memento();
    workspaceState.update("key", "blah");

    const { key, layer } = yield* withTestCtx({ workspaceState });

    yield* Effect.gen(function* () {
      const storage = yield* Storage;
      const result = yield* Effect.either(storage.workspace.get(key));

      assert(result._tag === "Left", "Expected to fail decoding");
      assert(result.left._tag === "StorageDecodeError");
    }).pipe(Effect.provide(layer));
  }),
);
