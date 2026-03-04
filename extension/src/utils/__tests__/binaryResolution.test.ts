import * as semver from "@std/semver";
import { describe, expect, it } from "vitest";

import { isVersionAtLeast, parseVersionOutput } from "../binaryResolution.ts";

describe("parseVersionOutput", () => {
  it("parses ruff version output", () => {
    expect(parseVersionOutput("ruff 0.15.0")).toBe("0.15.0");
  });

  it("parses ty version output", () => {
    expect(parseVersionOutput("ty 0.0.15")).toBe("0.0.15");
  });

  it("handles version with prerelease info", () => {
    expect(parseVersionOutput("ruff 0.15.0-dev")).toBe("0.15.0-dev");
  });

  it("handles trailing whitespace/newlines", () => {
    expect(parseVersionOutput("ruff 0.15.0\n")).toBe("0.15.0");
  });

  it("returns null for empty output", () => {
    expect(parseVersionOutput("")).toBeNull();
  });

  it("returns null for malformed output", () => {
    expect(parseVersionOutput("not a version")).toBeNull();
  });

  it("returns null for output without version number", () => {
    expect(parseVersionOutput("ruff")).toBeNull();
  });
});

describe("isVersionAtLeast", () => {
  it("returns true when actual equals minimum", () => {
    const actual = semver.parse("0.15.0");
    expect(isVersionAtLeast(actual, "0.15.0")).toBe(true);
  });

  it("returns true when actual is greater than minimum", () => {
    const actual = semver.parse("0.16.0");
    expect(isVersionAtLeast(actual, "0.15.0")).toBe(true);
  });

  it("returns true when actual has higher patch", () => {
    const actual = semver.parse("0.15.1");
    expect(isVersionAtLeast(actual, "0.15.0")).toBe(true);
  });

  it("returns false when actual is less than minimum", () => {
    const actual = semver.parse("0.14.0");
    expect(isVersionAtLeast(actual, "0.15.0")).toBe(false);
  });

  it("returns false for invalid minimum version", () => {
    const actual = semver.parse("0.15.0");
    expect(isVersionAtLeast(actual, "not-a-version")).toBe(false);
  });

  it("works with ty versioning (0.0.x)", () => {
    const actual = semver.parse("0.0.15");
    expect(isVersionAtLeast(actual, "0.0.15")).toBe(true);
    expect(isVersionAtLeast(actual, "0.0.14")).toBe(true);
    expect(isVersionAtLeast(actual, "0.0.16")).toBe(false);
  });
});
