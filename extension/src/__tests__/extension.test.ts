import { describe, expect, it, vi } from "vitest";
import { createVSCodeMock } from "../__mocks__/vscode";

vi.mock("vscode", () => createVSCodeMock(vi));
vi.mock("vscode-languageclient/node", () => createVSCodeLanguageClientMock(vi));
vi.mock("@vscode/python-extension", () => createPythonExtensionMock(vi));

import { createMockContext } from "../__mocks__/context";
import { createPythonExtensionMock } from "../__mocks__/python-extension";
import { createVSCodeLanguageClientMock } from "../__mocks__/vscode-languageclient";
import { activate } from "../extension";

describe("extension", () => {
  it("should be defined", () => {
    expect(activate(createMockContext())).toBeDefined();
  });
});
