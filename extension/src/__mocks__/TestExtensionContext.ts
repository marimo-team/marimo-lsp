import { Effect, Layer } from "effect";
import { ExtensionContext } from "../services/Storage.ts";

export class Memento {
  #map = new Map<string, unknown>();
  keys() {
    return Array.from(this.#map.keys());
  }
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

export const TestExtensionContextLive = Layer.succeed(ExtensionContext, {
  globalState: new Memento(),
  workspaceState: new Memento(),
});

export async function getExtensionContext() {
  return Effect.gen(function* () {
    const context = yield* ExtensionContext;
    return context;
  }).pipe(Effect.provide(TestExtensionContextLive), Effect.runPromise);
}
