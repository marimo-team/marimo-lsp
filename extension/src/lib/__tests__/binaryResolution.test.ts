import { describe, expect, it } from "@effect/vitest";
import { Effect, Logger, Option, References } from "effect";

import {
  BinarySource,
  type ResolutionSource,
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

/** Source that resolves to none. */
function emptySource(label: string): ResolutionSource {
  return { label, resolve: Effect.succeed(Option.none()) };
}

describe("resolveBinary", () => {
  it.effect(
    "returns the first source that resolves",
    Effect.fn(function* () {
      const result = yield* resolveBinary("test", [
        userSource("/first"),
        companionSource("/second"),
      ]);
      expect(result).toStrictEqual(
        Option.some(BinarySource.UserConfigured({ path: "/first" })),
      );
    }),
  );

  it.effect(
    "skips empty sources and returns the next match",
    Effect.fn(function* () {
      const result = yield* resolveBinary("test", [
        emptySource("skip"),
        companionSource("/good", "configured"),
      ]);
      expect(result).toStrictEqual(
        Option.some(
          BinarySource.CompanionExtension({
            extensionId: "test.ext",
            path: "/good",
            kind: "configured",
          }),
        ),
      );
    }),
  );

  it.effect(
    "returns none when every source is empty",
    Effect.fn(function* () {
      const result = yield* resolveBinary("test", [
        emptySource("a"),
        emptySource("b"),
      ]);
      expect(result).toStrictEqual(Option.none());
    }),
  );

  it.effect(
    "returns none when there are no sources at all",
    Effect.fn(function* () {
      const sources: ReadonlyArray<ResolutionSource> = [];
      expect(yield* resolveBinary("test", sources)).toStrictEqual(
        Option.none(),
      );
    }),
  );

  it.effect(
    "preserves CompanionExtension kind=bundled",
    Effect.fn(function* () {
      const result = yield* resolveBinary("ruff", [
        emptySource("user"),
        companionSource("/ext/bundled/libs/bin/ruff", "bundled"),
      ]);
      expect(
        Option.map(result, (source) =>
          BinarySource.$is("CompanionExtension")(source) ? source.kind : null,
        ),
      ).toStrictEqual(Option.some("bundled"));
    }),
  );

  it.effect(
    "emits structured logs with server and source annotations",
    Effect.fn(function* () {
      const logs = yield* collectLogs(
        resolveBinary("ty", [emptySource("tier-1"), userSource("/bin/ty")]),
      );

      const serverAnnotated = logs.filter((l) => l.annotations.server === "ty");
      expect(serverAnnotated.length).toBeGreaterThan(0);

      const resolved = logs.find((l) => l.message.includes("Resolved"));
      expect(resolved).toMatchObject({
        annotations: { source: "UserConfigured", path: "/bin/ty" },
      });
    }),
  );

  it.effect(
    "logs every source it tried when nothing resolves",
    Effect.fn(function* () {
      const logs = yield* collectLogs(
        resolveBinary("ty", [emptySource("tier-1"), emptySource("tier-2")]),
      );

      const unresolved = logs.find((l) =>
        l.message.includes("No source resolved a binary"),
      );
      expect(unresolved).toMatchObject({
        annotations: { server: "ty", sources: ["tier-1", "tier-2"] },
      });
    }),
  );
});

/** Runs `effect` at debug level, capturing every log line it emits. */
function collectLogs(effect: Effect.Effect<unknown>) {
  const logs: Array<{
    message: string;
    annotations: Record<string, unknown>;
  }> = [];
  return effect.pipe(
    Effect.provideService(References.MinimumLogLevel, "Debug"),
    Effect.provide(
      Logger.layer([
        Logger.make(({ message, fiber }) => {
          logs.push({
            message: String(message),
            annotations: {
              ...fiber.getRef(References.CurrentLogAnnotations),
            },
          });
        }),
      ]),
    ),
    Effect.as(logs),
  );
}
