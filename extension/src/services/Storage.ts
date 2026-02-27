import { Brand, Context, Data, Effect, Option, Schema } from "effect";
import type * as vscode from "vscode";

export class StorageError extends Data.TaggedError("StorageError")<{
  cause: unknown;
}> {}

export class StorageDecodeError extends Data.TaggedError("StorageDecodeError")<{
  cause: unknown;
}> {}

/**
 * Provides the VSCode ExtensionContext to the Effect runtime.
 */
export class ExtensionContext extends Context.Tag("ExtensionContext")<
  ExtensionContext,
  Pick<
    vscode.ExtensionContext,
    "workspaceState" | "globalState" | "extensionUri" | "globalStorageUri"
  >
>() {}

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
  readonly schema: Schema.Schema<A, I>;
}

/**
 * Create a type-safe storage key with an associated schema.
 */
export const createStorageKey = <A, I = A>(
  key: string,
  schema: Schema.Schema<A, I>,
): StorageKey<A, I> => ({
  key: Brand.nominal<StorageKeyId<A, I>>()(key as StorageKeyId<A, I>),
  schema,
});

/**
 * Generic wrapper around VSCode Memento for type-safe storage operations.
 */
class MementoStorage<_Scope extends "workspace" | "global"> {
  private readonly memento: vscode.Memento;

  constructor(memento: vscode.Memento) {
    this.memento = memento;
  }

  /**
   * Get a value from storage with type safety and schema validation.
   */
  get<A, I>(
    storageKey: StorageKey<A, I>,
  ): Effect.Effect<Option.Option<A>, StorageDecodeError> {
    return Effect.gen(this, function* () {
      const raw = this.memento.get(storageKey.key);
      if (raw === undefined) {
        return Option.none();
      }

      const decoded = yield* Schema.decodeUnknown(storageKey.schema)(raw).pipe(
        Effect.mapError((cause) => new StorageDecodeError({ cause })),
      );

      return Option.some(decoded);
    });
  }

  /**
   * Get a value from storage with a default fallback.
   */
  getWithDefault<A, I>(
    storageKey: StorageKey<A, I>,
    defaultValue: A,
  ): Effect.Effect<A, StorageDecodeError> {
    return this.get(storageKey).pipe(
      Effect.map((option) => Option.getOrElse(option, () => defaultValue)),
    );
  }

  /**
   * Set a value in storage with schema encoding.
   */
  set<A, I>(
    storageKey: StorageKey<A, I>,
    value: A,
  ): Effect.Effect<void, StorageError | StorageDecodeError> {
    return Effect.gen(this, function* () {
      const encoded = yield* Schema.encode(storageKey.schema)(value).pipe(
        Effect.mapError((cause) => new StorageDecodeError({ cause })),
      );

      yield* Effect.tryPromise({
        try: () => this.memento.update(storageKey.key, encoded),
        catch: (cause) => new StorageError({ cause }),
      });
    });
  }

  /**
   * Delete a key from storage.
   */
  delete<A, I>(
    storageKey: StorageKey<A, I>,
  ): Effect.Effect<void, StorageError> {
    return Effect.tryPromise({
      try: () => this.memento.update(storageKey.key, undefined),
      catch: (cause) => new StorageError({ cause }),
    });
  }

  /**
   * Get all keys in storage (if supported by the memento).
   */
  getKeys(): readonly string[] {
    return this.memento.keys();
  }
}

/**
 * Storage service providing type-safe access to workspace and global state.
 */
export class Storage extends Effect.Service<Storage>()("Storage", {
  effect: Effect.gen(function* () {
    const context = yield* ExtensionContext;

    return {
      /**
       * Access workspace-scoped storage (per workspace).
       */
      workspace: new MementoStorage<"workspace">(context.workspaceState),

      /**
       * Access global storage (across all workspaces).
       */
      global: new MementoStorage<"global">(context.globalState),
    };
  }),
}) {}
