import { describe, expect, it } from "@effect/vitest";
import * as semver from "@std/semver";
import { Effect, Logger, LogLevel, Option } from "effect";

import {
  BinarySource,
  type ResolutionSource,
  isVersionAtLeast,
  parseVersionOutput,
  resolveBinary,
} from "../binaryResolution.ts";

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

// ---------------------------------------------------------------------------
// resolveBinary
// ---------------------------------------------------------------------------

/** Source that resolves to a UserConfigured variant. */
function userSource(path: string): ResolutionSource {
  return {
    label: "user",
    resolve: Effect.succeed(Option.some(BinarySource.UserConfigured({ path }))),
  };
}

/** Source that resolves to a CompanionExtension variant. */
function companionSource(
  path: string,
  kind: "configured" | "bundled" = "bundled",
): ResolutionSource {
  return {
    label: "companion",
    resolve: Effect.succeed(
      Option.some(
        BinarySource.CompanionExtension({
          extensionId: "test.ext",
          path,
          kind,
        }),
      ),
    ),
  };
}

/** Source that resolves to a UvInstalled variant. */
function uvSource(path: string): ResolutionSource {
  return {
    label: "uv",
    resolve: Effect.succeed(Option.some(BinarySource.UvInstalled({ path }))),
  };
}

/** Source that resolves to none. */
function emptySource(label: string): ResolutionSource {
  return { label, resolve: Effect.succeed(Option.none()) };
}

describe("resolveBinary", () => {
  it.effect(
    "returns the first source that resolves",
    Effect.fn(function* () {
      const result = yield* resolveBinary(
        "test",
        [userSource("/first"), companionSource("/second")],
        uvSource("/fallback"),
      );
      expect(result._tag).toBe("UserConfigured");
      expect(result.path).toBe("/first");
    }),
  );

  it.effect(
    "skips empty sources and returns the next match",
    Effect.fn(function* () {
      const result = yield* resolveBinary(
        "test",
        [emptySource("skip"), companionSource("/good", "configured")],
        uvSource("/fallback"),
      );
      expect(result._tag).toBe("CompanionExtension");
      expect(result.path).toBe("/good");
      if (BinarySource.$is("CompanionExtension")(result)) {
        expect(result.kind).toBe("configured");
        expect(result.extensionId).toBe("test.ext");
      }
    }),
  );

  it.effect(
    "falls through to fallback when all sources are empty",
    Effect.fn(function* () {
      const result = yield* resolveBinary(
        "test",
        [emptySource("a"), emptySource("b")],
        uvSource("/fallback/binary"),
      );
      expect(result._tag).toBe("UvInstalled");
      expect(result.path).toBe("/fallback/binary");
    }),
  );

  it.effect(
    "uses fallback when sources array is empty",
    Effect.fn(function* () {
      const result = yield* resolveBinary("test", [], uvSource("/only/option"));
      expect(result._tag).toBe("UvInstalled");
      expect(result.path).toBe("/only/option");
    }),
  );

  it.effect(
    "dies when fallback also returns none",
    Effect.fn(function* () {
      const exit = yield* Effect.exit(
        resolveBinary("test", [emptySource("a")], emptySource("fallback")),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect(
    "preserves CompanionExtension kind=bundled",
    Effect.fn(function* () {
      const result = yield* resolveBinary(
        "ruff",
        [
          emptySource("user"),
          companionSource("/ext/bundled/libs/bin/ruff", "bundled"),
        ],
        uvSource("/uv/bin/ruff"),
      );
      expect(result._tag).toBe("CompanionExtension");
      if (BinarySource.$is("CompanionExtension")(result)) {
        expect(result.kind).toBe("bundled");
      }
    }),
  );

  it.effect(
    "emits structured logs with server and source annotations",
    Effect.fn(function* () {
      const logs: Array<{
        message: string;
        annotations: Record<string, unknown>;
      }> = [];

      yield* resolveBinary(
        "ty",
        [emptySource("tier-1"), userSource("/bin/ty")],
        uvSource("/fallback"),
      ).pipe(
        Logger.withMinimumLogLevel(LogLevel.Debug),
        Effect.provide(
          Logger.replace(
            Logger.defaultLogger,
            Logger.make(({ message, annotations }) => {
              logs.push({
                message: String(message),
                annotations: Object.fromEntries(annotations),
              });
            }),
          ),
        ),
      );

      const serverAnnotated = logs.filter((l) => l.annotations.server === "ty");
      expect(serverAnnotated.length).toBeGreaterThan(0);

      const resolved = logs.find((l) => String(l.message).includes("Resolved"));
      expect(resolved).toBeDefined();
      expect(resolved!.annotations.source).toBe("UserConfigured");
      expect(resolved!.annotations.path).toBe("/bin/ty");
    }),
  );
});
