import { assert, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { Memento } from "../../__mocks__/TestExtensionContext.ts";
import { TestVsCodeLive } from "../../__mocks__/TestVsCode.ts";
import {
  createStorageKey,
  ExtensionContext,
  Storage,
} from "../../services/Storage.ts";

const StorageLive = Layer.empty.pipe(
  Layer.provideMerge(Storage.Default),
  Layer.provide(TestVsCodeLive),
  Layer.provideMerge(
    Layer.succeed(ExtensionContext, {
      globalState: new Memento(),
      workspaceState: new Memento(),
    }),
  ),
);

it.layer(StorageLive)("Storage", (it) => {
  const key = createStorageKey("key", Schema.Struct({ value: Schema.Int }));

  it.effect(
    "should return Option.None when no entry",
    Effect.fnUntraced(function* () {
      const storage = yield* Storage;
      const value = yield* storage.workspace.get(key);
      assert(Option.isOption(value));
    }),
  );

  it.effect(
    "should fallback to default without updating storage",
    Effect.fnUntraced(function* () {
      const storage = yield* Storage;
      const defaultValue = { value: 1 };

      const value = yield* storage.workspace.getWithDefault(key, defaultValue);
      expect(value).toEqual(defaultValue);

      const context = yield* ExtensionContext;
      expect(context).toMatchInlineSnapshot(`
        {
          "globalState": {},
          "workspaceState": {},
        }
      `);
    }),
  );

  it.effect(
    "should encode value into the underlying store",
    Effect.fnUntraced(function* () {
      const storage = yield* Storage;
      yield* storage.workspace.set(key, { value: 2 });

      const context = yield* ExtensionContext;
      expect(context).toMatchInlineSnapshot(`
        {
          "globalState": {},
          "workspaceState": {
            "key": {
              "value": 2,
            },
          },
        }
      `);
    }),
  );

  it.effect(
    "should replace existing value in the underlying store",
    Effect.fnUntraced(function* () {
      const storage = yield* Storage;
      yield* storage.workspace.set(key, { value: 3 });

      const context = yield* ExtensionContext;
      expect(context).toMatchInlineSnapshot(`
        {
          "globalState": {},
          "workspaceState": {
            "key": {
              "value": 3,
            },
          },
        }
      `);
    }),
  );

  it.effect.fails(
    "should throw StorageDecodeError badly encoded value",
    Effect.fnUntraced(function* () {
      const storage = yield* Storage;
      const context = yield* ExtensionContext;

      yield* Effect.promise(() => context.workspaceState.update("key", "blah"));
      yield* storage.workspace.get(key);
    }),
  );
});
