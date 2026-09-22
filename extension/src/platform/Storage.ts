import { Brand, Context, Data, Effect, Layer, Option, Schema } from "effect";
import type * as vscode from "vscode";

import * as ExtensionContext from "./ExtensionContext.ts";

export class Error extends Data.TaggedError("Storage.Error")<{
  readonly cause: unknown;
}> {}

export class DecodeError extends Data.TaggedError("Storage.DecodeError")<{
  readonly cause: unknown;
}> {}

/**
 * Branded storage key that carries the schema type information.
 */
export type StorageKeyId<A, I = A> = string &
  Brand.Brand<"StorageKey"> & {
    readonly _A: A;
    readonly _I: I;
  };

export interface StorageKey<A, I = A> {
  readonly key: StorageKeyId<A, I>;
  readonly schema: Schema.Codec<A, I>;
}

/**
 * Create a type-safe storage key with an associated schema.
 */
export const createStorageKey = <A, I = A>(
  key: string,
  schema: Schema.Codec<A, I>,
): StorageKey<A, I> => ({
  // SAFETY: StorageKeyId carries phantom `_A`/`_I` types that exist only at
  // the type level; the brand constructor expects the full branded shape but
  // the phantoms have no runtime representation.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  key: Brand.nominal<StorageKeyId<A, I>>()(key as StorageKeyId<A, I>),
  schema,
});

export interface Store {
  readonly get: <A, I>(
    storageKey: StorageKey<A, I>,
  ) => Effect.Effect<Option.Option<A>, DecodeError>;
  readonly getWithDefault: <A, I>(
    storageKey: StorageKey<A, I>,
    defaultValue: A,
  ) => Effect.Effect<A, DecodeError>;
  readonly set: <A, I>(
    storageKey: StorageKey<A, I>,
    value: A,
  ) => Effect.Effect<void, Error | DecodeError>;
  readonly delete: <A, I>(
    storageKey: StorageKey<A, I>,
  ) => Effect.Effect<void, Error>;
  readonly getKeys: () => readonly string[];
}

const makeStore = (memento: vscode.Memento): Store => {
  const get = Effect.fn("Storage.Store.get")(function* <A, I>(
    storageKey: StorageKey<A, I>,
  ) {
    const raw = memento.get(storageKey.key);
    if (raw === undefined) return Option.none();

    const decoded = yield* Schema.decodeUnknownEffect(storageKey.schema)(
      raw,
    ).pipe(Effect.mapError((cause) => new DecodeError({ cause })));
    return Option.some(decoded);
  });

  const getWithDefault = Effect.fn("Storage.Store.getWithDefault")(function* <
    A,
    I,
  >(storageKey: StorageKey<A, I>, defaultValue: A) {
    const value = yield* get(storageKey);
    return Option.getOrElse(value, () => defaultValue);
  });

  const set = Effect.fn("Storage.Store.set")(function* <A, I>(
    storageKey: StorageKey<A, I>,
    value: A,
  ) {
    const encoded = yield* Schema.encodeEffect(storageKey.schema)(value).pipe(
      Effect.mapError((cause) => new DecodeError({ cause })),
    );

    yield* Effect.tryPromise({
      try: () => memento.update(storageKey.key, encoded),
      catch: (cause) => new Error({ cause }),
    });
  });

  const deleteValue = Effect.fn("Storage.Store.delete")(function* <A, I>(
    storageKey: StorageKey<A, I>,
  ) {
    yield* Effect.tryPromise({
      try: () => memento.update(storageKey.key, undefined),
      catch: (cause) => new Error({ cause }),
    });
  });

  const getKeys = () => memento.keys();

  return { get, getWithDefault, set, delete: deleteValue, getKeys };
};

/**
 * Storage service providing type-safe access to workspace and global state.
 */
export interface Interface {
  readonly workspace: Store;
  readonly global: Store;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/Storage",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const context = yield* ExtensionContext.Service;

    return Service.of({
      /**
       * Access workspace-scoped storage (per workspace).
       */
      workspace: makeStore(context.workspaceState),

      /**
       * Access global storage (across all workspaces).
       */
      global: makeStore(context.globalState),
    });
  }),
);
