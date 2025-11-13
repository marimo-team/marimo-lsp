import { Effect, Layer } from "effect";
import type * as vscode from "vscode";
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
  extensionUri: {
    scheme: "file",
    authority: "",
    path: "/test/extension/path",
    query: "",
    fragment: "",
    fsPath: "/test/extension/path",
    with: () =>
      ({
        scheme: "file",
        authority: "",
        path: "/test",
        query: "",
        fragment: "",
        fsPath: "/test",
      }) as vscode.Uri,
    toString: () => "file:///test/extension/path",
    toJSON: () => ({
      scheme: "file",
      authority: "",
      path: "/test/extension/path",
      query: "",
      fragment: "",
    }),
  } as vscode.Uri,
});

export function getTestExtensionContext() {
  return Effect.gen(function* () {
    const context = yield* ExtensionContext;
    return context;
  }).pipe(Effect.provide(TestExtensionContextLive));
}
