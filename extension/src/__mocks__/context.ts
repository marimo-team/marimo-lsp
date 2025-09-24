import { vi } from "vitest";
import { type ExtensionContext, ExtensionMode, Uri } from "vscode";

export function createMockContext(): ExtensionContext {
  return {
    subscriptions: [],
    workspaceState: {
      keys: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
    },
    globalState: {
      keys: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      setKeysForSync: vi.fn(),
    },
    secrets: {
      get: vi.fn(),
      store: vi.fn(),
      delete: vi.fn(),
      onDidChange: vi.fn(),
    },
    extensionUri: Uri.file("/"),
    extensionMode: ExtensionMode.Test,
    storagePath: "/",
    extensionPath: "/",
    environmentVariableCollection: {},
    storageUri: Uri.file("/"),
    asAbsolutePath: vi.fn(),
  } as unknown as ExtensionContext;
}
