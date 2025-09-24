import type { VitestUtils } from "vitest";

export function createVSCodeLanguageClientMock(vi: VitestUtils) {
  return {
    BaseLanguageClient: vi.fn(),
    LanguageClient: vi.fn().mockImplementation(() => {
      return {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
        onNotification: vi.fn(),
      };
    }),
    TransportKind: vi.fn(),
    RevealOutputChannelOn: vi.fn(),
  };
}
