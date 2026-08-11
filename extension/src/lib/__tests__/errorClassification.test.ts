import { describe, expect, it } from "vite-plus/test";

import {
  exceptionClassFromMessage,
  hasExceptionClassPrefix,
  nestedErrorClassName,
  safeErrorClassName,
} from "../errorClassification.ts";

describe("errorClassification", () => {
  it("uses a custom Error constructor when name is inherited", () => {
    class KernelStartFailure extends Error {}

    const error = new KernelStartFailure("could not start");
    expect(error.name).toBe("Error");
    expect(safeErrorClassName(error)).toBe("KernelStartFailure");
    expect(nestedErrorClassName(error)).toBe("KernelStartFailure");
  });

  it("preserves an explicit Error name on RPC-shaped objects", () => {
    expect(safeErrorClassName({ name: "Error", message: "failed" })).toBe(
      "Error",
    );
  });

  it("parses bounded exception identifiers without requiring a suffix", () => {
    expect(
      exceptionClassFromMessage("builtins.KeyboardInterrupt: stopped"),
    ).toBe("KeyboardInterrupt");
    expect(exceptionClassFromMessage("KeyboardInterrupt: stopped")).toBe(
      "KeyboardInterrupt",
    );
    expect(exceptionClassFromMessage("my_package.Abort: stopped")).toBe(
      "Abort",
    );
  });

  it("excludes traceback headers and continuation labels", () => {
    expect(exceptionClassFromMessage("Traceback: unavailable")).toBeUndefined();
    expect(hasExceptionClassPrefix("Traceback: unavailable")).toBe(false);
    expect(exceptionClassFromMessage("Hint: rename this file")).toBeUndefined();
    expect(hasExceptionClassPrefix("Note: retrying may help")).toBe(false);
    expect(nestedErrorClassName(new Error("Hint: rename this file"))).toBe(
      "Error",
    );
  });

  it("keeps user-facing detection separate from telemetry bounds", () => {
    const className = `${"VeryLong".repeat(12)}Error`;
    const line = `${className}: failed`;

    expect(hasExceptionClassPrefix(line)).toBe(true);
    expect(exceptionClassFromMessage(line)).toBeUndefined();
  });
});
