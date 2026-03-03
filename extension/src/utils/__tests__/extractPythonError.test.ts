import { describe, expect, it } from "vitest";

import {
  extractModuleShadowingError,
  extractPythonError,
} from "../extractPythonError.ts";

describe("extractPythonError", () => {
  it("returns undefined for null/undefined", () => {
    expect(extractPythonError(null)).toBeUndefined();
    expect(extractPythonError(undefined)).toBeUndefined();
  });

  it("returns undefined for non-object", () => {
    expect(extractPythonError("string")).toBeUndefined();
    expect(extractPythonError(42)).toBeUndefined();
  });

  it("extracts from Error.cause with Python traceback", () => {
    const error = new Error("An error has occurred", {
      cause: new Error(
        "RuntimeError: Kernel failed to start (exit code 1): Traceback (most recent call last):\n" +
          '    File "<frozen runpy>", line 189, in _run_module_as_main\n' +
          '    File "/home/user/collections.py", line 1, in <module>\n' +
          "      from collections import namedtuple\n" +
          "  ImportError: cannot import name 'namedtuple' from 'collections'",
      ),
    });
    expect(extractPythonError(error)).toBe(
      "ImportError: cannot import name 'namedtuple' from 'collections'",
    );
  });

  it("extracts msgspec.ValidationError from cause chain", () => {
    const error = new Error("An error has occurred", {
      cause: new Error(
        "RuntimeError: Kernel failed to start (exit code 1): Traceback (most recent call last):\n" +
          '    File "/path/to/launch_kernel.py", line 28, in main\n' +
          "  msgspec.ValidationError: Expected `str`, got `object` - at `$.user_config.ai.rules`",
      ),
    });
    expect(extractPythonError(error)).toBe(
      "msgspec.ValidationError: Expected `str`, got `object` - at `$.user_config.ai.rules`",
    );
  });

  it("extracts AttributeError for file name shadowing", () => {
    const error = new Error("An error has occurred", {
      cause: new Error(
        "RuntimeError: Kernel failed to start (exit code 1): Traceback (most recent call last):\n" +
          '    File "/Users/user/projects/marimo.py", line 4, in <module>\n' +
          "      app = marimo.App()\n" +
          "  AttributeError: module 'marimo' has no attribute 'App' (consider renaming '/Users/user/projects/marimo.py')",
      ),
    });
    expect(extractPythonError(error)).toBe(
      "AttributeError: module 'marimo' has no attribute 'App' (consider renaming '/Users/user/projects/marimo.py')",
    );
  });

  it("falls back to .message when not generic", () => {
    const error = new Error("Something specific went wrong");
    expect(extractPythonError(error)).toBe("Something specific went wrong");
  });

  it("returns undefined when message is generic", () => {
    const error = new Error("An error has occurred");
    expect(extractPythonError(error)).toBeUndefined();
  });

  it("truncates very long error messages", () => {
    const longMessage = `SyntaxError: ${"x".repeat(600)}`;
    const error = new Error("An error has occurred", {
      cause: new Error(longMessage),
    });
    const result = extractPythonError(error);
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(501); // 500 + ellipsis
  });
});

describe("extractModuleShadowingError", () => {
  it("returns undefined for null/undefined", () => {
    expect(extractModuleShadowingError(null)).toBeUndefined();
    expect(extractModuleShadowingError(undefined)).toBeUndefined();
  });

  it("returns undefined for non-object", () => {
    expect(extractModuleShadowingError("string")).toBeUndefined();
    expect(extractModuleShadowingError(42)).toBeUndefined();
  });

  it("returns undefined for errors without consider renaming", () => {
    const error = new Error("ImportError: No module named 'foo'");
    expect(extractModuleShadowingError(error)).toBeUndefined();
  });

  it("extracts marimo.py shadowing from direct message", () => {
    const error = new Error(
      "AttributeError: module 'marimo' has no attribute 'App' (consider renaming '/Users/user/projects/marimo.py' if it has the same name as a library you intended to import)",
    );
    expect(extractModuleShadowingError(error)).toBe(
      "A file in your project named 'marimo.py' is shadowing a Python module. Consider renaming it.",
    );
  });

  it("extracts shadowing from Error.cause chain", () => {
    const error = new Error("An error has occurred", {
      cause: new Error(
        "RuntimeError: Kernel failed to start (exit code 1): Traceback (most recent call last):\n" +
          '    File "/Users/user/projects/marimo.py", line 4, in <module>\n' +
          "      app = marimo.App()\n" +
          "  AttributeError: module 'marimo' has no attribute 'App' (consider renaming '/Users/user/projects/marimo.py')",
      ),
    });
    expect(extractModuleShadowingError(error)).toBe(
      "A file in your project named 'marimo.py' is shadowing a Python module. Consider renaming it.",
    );
  });

  it("extracts stdlib shadowing (collections.py)", () => {
    const error = new Error("An error has occurred", {
      cause: new Error(
        "ImportError: cannot import name 'namedtuple' from 'collections' (consider renaming '/home/user/collections.py')",
      ),
    });
    expect(extractModuleShadowingError(error)).toBe(
      "A file in your project named 'collections.py' is shadowing a Python module. Consider renaming it.",
    );
  });

  it("extracts arbitrary file shadowing (bah.py)", () => {
    const error = new Error(
      "AttributeError: module 'bah' has no attribute 'foo' (consider renaming '/Users/tmanz/github/marimo-team/marimo-lsp/bah.py' if it has the same name as a library you intended to import)",
    );
    expect(extractModuleShadowingError(error)).toBe(
      "A file in your project named 'bah.py' is shadowing a Python module. Consider renaming it.",
    );
  });

  it("returns undefined for generic error", () => {
    const error = new Error("An error has occurred");
    expect(extractModuleShadowingError(error)).toBeUndefined();
  });
});
