import type { VitestUtils } from "vitest";

export function createPythonExtensionMock(vi: VitestUtils) {
  return {
    PythonExtension: {
      api: vi.fn().mockResolvedValue({
        environments: {
          known: [],
          onDidChangeEnvironments: vi.fn().mockReturnValue({
            dispose: vi.fn(),
          }),
        },
      }),
    },
  };
}
