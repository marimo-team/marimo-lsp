import { describe, expect, it, vi } from "vitest";
import { createVSCodeMock } from "../__mocks__/vscode.ts";

vi.mock("vscode", () => createVSCodeMock(vi));
vi.mock("vscode-languageclient/node", () => createVSCodeLanguageClientMock(vi));
vi.mock("@vscode/python-extension", () => createPythonExtensionMock(vi));

import { createMockContext } from "../__mocks__/context.ts";
import { createPythonExtensionMock } from "../__mocks__/python-extension.ts";
import { createVSCodeLanguageClientMock } from "../__mocks__/vscode-languageclient.ts";

import { activate } from "../extension.ts";

describe("extension", () => {
  it("activation returns expected interface", async () => {
    const result = await activate(createMockContext());
    expect(result).toMatchInlineSnapshot(`
      {
        "dispose": [Function],
      }
    `);
  });
});
