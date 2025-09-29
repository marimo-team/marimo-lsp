import type { VitestUtils } from "vitest";

export function createVSCodeLanguageClientMock(vi: VitestUtils) {
  return {
    BaseLanguageClient: vi.fn(),
    LanguageClient: vi.fn().mockImplementation(() => {
      return {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        onNotification: vi.fn().mockReturnValue({ dispose: vi.fn() }),
        sendRequest: vi.fn().mockResolvedValue(undefined),
      };
    }),
    TransportKind: {
      stdio: 0,
      ipc: 1,
      pipe: 2,
      socket: 3,
    },
    RevealOutputChannelOn: {
      Info: 1,
      Warn: 2,
      Error: 3,
      Never: 4,
    },
  };
}
