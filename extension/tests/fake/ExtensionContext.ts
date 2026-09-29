import { Effect, Layer } from "effect";

import * as ExtensionContext from "../../src/platform/ExtensionContext.ts";
import { Uri } from "./VsCode.ts";

export class Memento {
  #map = new Map<string, unknown>();
  keys() {
    return Array.from(this.#map.keys());
  }
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-type-parameters
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    // @ts-expect-error - typing is unsafe in VS Code
    return this.#map.get(key) ?? defaultValue;
  }
  async update(key: string, value: unknown) {
    this.#map.set(key, value);
  }
  setKeysForSync() {}

  toJSON() {
    return Object.fromEntries(this.#map.entries());
  }
}

/** A fresh extension context with empty global and workspace state. */
export const make = () => ({
  globalState: new Memento(),
  workspaceState: new Memento(),
  extensionUri: Uri.parse("file:///test/extension/path", true),
  globalStorageUri: Uri.parse("file://test/extension/libs", true),
});

/** A new context for every caller, so state never leaks between tests. */
export const get = Effect.sync(make);

/** Provides a fresh context for every layer build. */
export const layer = Layer.unwrap(
  Effect.map(get, (context) =>
    Layer.succeed(ExtensionContext.Service, context),
  ),
);
