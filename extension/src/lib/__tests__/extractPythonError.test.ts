import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { extractPythonError } from "../extractPythonError.ts";

describe("extractPythonError", () => {
  it("returns none for null/undefined", () => {
    expect(extractPythonError(null)).toEqual(Option.none());
    expect(extractPythonError(undefined)).toEqual(Option.none());
  });

  it("returns none for non-object", () => {
    expect(extractPythonError("string")).toEqual(Option.none());
    expect(extractPythonError(42)).toEqual(Option.none());
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
    expect(extractPythonError(error)).toEqual(
      Option.some(
        "ImportError: cannot import name 'namedtuple' from 'collections'",
      ),
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
    expect(extractPythonError(error)).toEqual(
      Option.some(
        "msgspec.ValidationError: Expected `str`, got `object` - at `$.user_config.ai.rules`",
      ),
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
    expect(extractPythonError(error)).toEqual(
      Option.some(
        "AttributeError: module 'marimo' has no attribute 'App' (consider renaming '/Users/user/projects/marimo.py')",
      ),
    );
  });

  it("falls back to .message when not generic", () => {
    const error = new Error("Something specific went wrong");
    expect(extractPythonError(error)).toEqual(
      Option.some("Something specific went wrong"),
    );
  });

  it("returns none when message is generic", () => {
    const error = new Error("An error has occurred");
    expect(extractPythonError(error)).toEqual(Option.none());
  });

  it("truncates very long error messages", () => {
    const longMessage = `SyntaxError: ${"x".repeat(600)}`;
    const error = new Error("An error has occurred", {
      cause: new Error(longMessage),
    });
    const result = extractPythonError(error);
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value.length).toBeLessThanOrEqual(501); // 500 + ellipsis
    }
  });
});
