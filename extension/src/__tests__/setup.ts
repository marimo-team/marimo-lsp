import { vi } from "vitest";

vi.mock("vscode", () => ({}));
vi.mock("vscode-languageclient/node", () => ({
  // oxlint-disable-next-line no-extraneous-class
  LanguageClient: class {
    constructor() {
      throw new Error(
        "LanguageClient was constructed in a test. " +
        "This should be mocked or injected—production code leaked into the test.",
      );
    }
  },
}));
vi.mock("@vscode/python-extension", () => ({}));
