/**
 * Unit tests for the file-watcher glob conversion in `connect.ts`.
 *
 * Regression coverage for the bug where ty's external function/class
 * definitions never reloaded: the client advertises
 * `relativePatternSupport: true`, so ty registers its file watchers as
 * `RelativePattern` objects (`{ baseUri, pattern }`) rather than string
 * globs. The watcher-wiring code previously dropped every non-string
 * pattern, so no `vscode.FileSystemWatcher` was ever created and on-disk
 * edits never reached ty.
 */

import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { VsCode } from "../../platform/VsCode.ts";
import { toVsCodeGlobPattern } from "../connect.ts";

describe("toVsCodeGlobPattern", () => {
  it.scoped("passes string globs through unchanged", () =>
    Effect.gen(function* () {
      const test = yield* TestVsCode.make();
      const code = yield* VsCode.pipe(Effect.provide(test.layer));

      const result = toVsCodeGlobPattern(code, "**/*.py");

      expect(Option.getOrThrow(result)).toBe("**/*.py");
    }),
  );

  it.scoped(
    "converts a RelativePattern object into a vscode.RelativePattern",
    () =>
      Effect.gen(function* () {
        const test = yield* TestVsCode.make();
        const code = yield* VsCode.pipe(Effect.provide(test.layer));

        // The exact shape ty sends when relativePatternSupport is on:
        // a file:// baseUri pointing at a project root / search path,
        // with the catch-all "**" pattern.
        const result = toVsCodeGlobPattern(code, {
          baseUri: "file:///home/me/project",
          pattern: "**",
        });

        const pattern = Option.getOrThrow(result);
        // Must be a structured RelativePattern, not dropped or stringified.
        if (typeof pattern === "string") {
          throw new Error("expected a RelativePattern, got a string glob");
        }
        expect(pattern.pattern).toBe("**");
        expect(pattern.baseUri.toString()).toBe("file:///home/me/project");
      }),
  );

  it.scoped("rejects shapes it cannot interpret", () =>
    Effect.gen(function* () {
      const test = yield* TestVsCode.make();
      const code = yield* VsCode.pipe(Effect.provide(test.layer));

      // A workspace-folder baseUri (object, not string) — ty never emits
      // this, and we can't resolve it here, so it must be skipped rather
      // than crashing the watcher loop.
      expect(
        Option.isNone(
          toVsCodeGlobPattern(code, {
            baseUri: { uri: "file:///x", name: "x", index: 0 },
            pattern: "**",
          }),
        ),
      ).toBe(true);
      expect(Option.isNone(toVsCodeGlobPattern(code, undefined))).toBe(true);
      expect(Option.isNone(toVsCodeGlobPattern(code, 42))).toBe(true);
    }),
  );

  it.scoped("returns None when baseUri can't be parsed", () =>
    Effect.gen(function* () {
      const test = yield* TestVsCode.make();
      const code = yield* VsCode.pipe(Effect.provide(test.layer));

      // Uri.parse rejects a scheme-less baseUri by throwing; the converter
      // must swallow that and skip the watcher, not abort registration.
      expect(
        Option.isNone(
          toVsCodeGlobPattern(code, {
            baseUri: "not-a-valid-uri",
            pattern: "**",
          }),
        ),
      ).toBe(true);
    }),
  );
});
