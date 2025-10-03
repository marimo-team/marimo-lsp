import { vi } from "vitest";
import { createVSCodeMock } from "../__mocks__/vscode.ts";

vi.mock("vscode", () => createVSCodeMock(vi));
vi.mock("vscode-languageclient/node", () => createVSCodeLanguageClientMock(vi));
vi.mock("@vscode/python-extension", () => createPythonExtensionMock(vi));

import { createPythonExtensionMock } from "../__mocks__/python-extension.ts";
import { createVSCodeLanguageClientMock } from "../__mocks__/vscode-languageclient.ts";
