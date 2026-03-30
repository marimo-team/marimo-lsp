import { describe, expect, it } from "vitest";

import { Uri } from "../../__mocks__/TestVsCode.ts";
import { isProblematicFilename } from "../validateNotebookFilename.ts";

describe("isProblematicFilename", () => {
  it("blocks marimo.py", () => {
    const result = isProblematicFilename(Uri.file("/Users/user/marimo.py"));
    expect(result.problematic).toBe(true);
    expect(result).toMatchObject({
      problematic: true,
      message: expect.stringContaining("marimo package"),
    });
  });

  it("allows normal notebook names", () => {
    expect(
      isProblematicFilename(Uri.file("/Users/user/my_notebook.py")),
    ).toEqual({ problematic: false });
  });

  it("allows marimo in directory name", () => {
    expect(
      isProblematicFilename(Uri.file("/Users/user/marimo/notebook.py")),
    ).toEqual({ problematic: false });
  });

  it("blocks collections.py (stdlib)", () => {
    const result = isProblematicFilename(
      Uri.file("/Users/user/collections.py"),
    );
    expect(result.problematic).toBe(true);
    expect(result).toMatchObject({
      problematic: true,
      message: expect.stringContaining("'collections'"),
    });
  });

  it("blocks os.py (stdlib)", () => {
    const result = isProblematicFilename(Uri.file("/Users/user/os.py"));
    expect(result.problematic).toBe(true);
    expect(result).toMatchObject({
      problematic: true,
      message: expect.stringContaining("'os'"),
    });
  });

  it("blocks json.py (stdlib)", () => {
    const result = isProblematicFilename(Uri.file("/Users/user/json.py"));
    expect(result.problematic).toBe(true);
    expect(result).toMatchObject({
      problematic: true,
      message: expect.stringContaining("'json'"),
    });
  });

  it("blocks typing.py (stdlib)", () => {
    const result = isProblematicFilename(Uri.file("/Users/user/typing.py"));
    expect(result.problematic).toBe(true);
    expect(result).toMatchObject({
      problematic: true,
      message: expect.stringContaining("'typing'"),
    });
  });

  it("allows non-.py files", () => {
    expect(isProblematicFilename(Uri.file("/Users/user/marimo.txt"))).toEqual({
      problematic: false,
    });
  });

  it("allows partial matches (e.g. marimolib.py)", () => {
    expect(isProblematicFilename(Uri.file("/Users/user/marimolib.py"))).toEqual(
      { problematic: false },
    );
  });

  it("gives marimo-specific message for marimo.py", () => {
    const result = isProblematicFilename(Uri.file("/home/user/marimo.py"));
    expect(result.problematic).toBe(true);
    if (result.problematic) {
      expect(result.message).toContain("marimo package");
      expect(result.message).not.toContain("built-in");
    }
  });

  it("gives stdlib-specific message for stdlib modules", () => {
    const result = isProblematicFilename(Uri.file("/home/user/collections.py"));
    expect(result.problematic).toBe(true);
    if (result.problematic) {
      expect(result.message).toContain("built-in");
      expect(result.message).toContain("'collections'");
    }
  });
});
