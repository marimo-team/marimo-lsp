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
  });

  it("excludes traceback headers", () => {
    expect(exceptionClassFromMessage("Traceback: unavailable")).toBeUndefined();
    expect(hasExceptionClassPrefix("Traceback: unavailable")).toBe(false);
  });

  it("keeps user-facing detection separate from telemetry bounds", () => {
    const className = `${"VeryLong".repeat(12)}Error`;
    const line = `${className}: failed`;

    expect(hasExceptionClassPrefix(line)).toBe(true);
    expect(exceptionClassFromMessage(line)).toBeUndefined();
  });
});
