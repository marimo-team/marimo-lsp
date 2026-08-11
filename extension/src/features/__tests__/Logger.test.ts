import { describe, expect, it } from "@effect/vitest";
import { Effect, Logger, References, Tracer } from "effect";

import { withSpanAnnotations } from "../Logger.ts";

/** Records the annotations of each log record. */
const captureAnnotations = (into: Array<Record<string, unknown>>) =>
  withSpanAnnotations(
    Logger.make<unknown, void>(({ fiber }) => {
      into.push({ ...fiber.getRef(References.CurrentLogAnnotations) });
    }),
  );

describe("withSpanAnnotations", () => {
  it.effect(
    "annotates span identity even when the span has no attributes",
    Effect.fn(function* () {
      const seen: Array<Record<string, unknown>> = [];

      yield* Effect.logError("boom").pipe(
        Effect.withSpan("kernel.restart"),
        Effect.provide(Logger.layer([captureAnnotations(seen)])),
      );

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ "effect.spanName": "kernel.restart" });
      expect(seen[0]?.["effect.traceId"]).toEqual(expect.any(String));
      expect(seen[0]?.["effect.spanId"]).toEqual(expect.any(String));
    }),
  );

  it.effect(
    "keeps span attributes alongside identity",
    Effect.fn(function* () {
      const seen: Array<Record<string, unknown>> = [];

      yield* Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({ "notebook.uri": "file:///nb.py" });
        yield* Effect.logError("boom");
      }).pipe(
        Effect.withSpan("kernel.restart"),
        Effect.provide(Logger.layer([captureAnnotations(seen)])),
      );

      expect(seen[0]).toMatchObject({
        "notebook.uri": "file:///nb.py",
        "effect.spanName": "kernel.restart",
      });
    }),
  );

  it.effect(
    "annotates ids but no name for an external parent span",
    Effect.fn(function* () {
      const seen: Array<Record<string, unknown>> = [];

      yield* Effect.logError("boom").pipe(
        Effect.withParentSpan(
          Tracer.externalSpan({ spanId: "span-1", traceId: "trace-1" }),
        ),
        Effect.provide(Logger.layer([captureAnnotations(seen)])),
      );

      expect(seen[0]).toMatchObject({
        "effect.traceId": "trace-1",
        "effect.spanId": "span-1",
      });
      expect(seen[0]).not.toHaveProperty("effect.spanName");
    }),
  );

  it.effect(
    "leaves annotations untouched with no span",
    Effect.fn(function* () {
      const seen: Array<Record<string, unknown>> = [];

      yield* Effect.logError("boom").pipe(
        Effect.annotateLogs({ "cell.id": "cell-1" }),
        Effect.provide(Logger.layer([captureAnnotations(seen)])),
      );

      expect(seen[0]).toEqual({ "cell.id": "cell-1" });
    }),
  );
});
