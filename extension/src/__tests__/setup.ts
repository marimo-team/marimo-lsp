import { vi } from "vitest";

vi.mock("vscode", () => ({}));
vi.mock("vscode-languageclient/node", () => ({}));
vi.mock("@vscode/python-extension", () => ({}));
