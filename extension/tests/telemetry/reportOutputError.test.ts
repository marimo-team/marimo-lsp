import { Cause, Effect, Logger, References } from "effect";
import { expect, it } from "vite-plus/test";

import { reportOutputError } from "../../src/telemetry/reportOutputError.ts";
import { classifySentryError } from "../../src/telemetry/sentrySink.ts";

const report = {
  component: "marimo-table",
  name: "TypeError",
  message: "Cannot read properties of undefined (reading 'read')",
  stack: "TypeError: table failed\n    at ExportActions (renderer.mjs:100:10)",
  componentStack: "\n    at ExportActions\n    at TableProviders",
};

it("preserves the browser exception and component through the telemetry logger", () => {
  const logs: unknown[] = [];
  const logger = Logger.make(({ cause, fiber }) => {
    const reason = cause.reasons.find(Cause.isFailReason);
    const annotations = fiber.getRef(References.CurrentLogAnnotations);
    logs.push({ error: reason?.error, annotations });
  });
  Effect.runSync(
    reportOutputError(report).pipe(Effect.provide(Logger.layer([logger]))),
  );
  expect(logs).toEqual([
    {
      error: expect.objectContaining({
        name: report.name,
        message: report.message,
        stack: report.stack,
      }),
      annotations: {
        "error.domain": "renderer.output",
        "renderer.component": "marimo-table",
        "renderer.component_stack": report.componentStack,
      },
    },
  ]);
  expect(
    classifySentryError(new TypeError(report.message), {
      "error.domain": "renderer.output",
      "renderer.component": report.component,
    }),
  ).toEqual({
    tags: {
      "error.domain": "renderer.output",
      "renderer.component": "marimo-table",
    },
    fingerprint: undefined,
  });
});

it("drops malformed, oversized, and anywidget reports at the host boundary", () => {
  const logs: unknown[] = [];
  const logger = Logger.make(({ message }) => logs.push(message));
  const invalid = [
    null,
    {},
    { ...report, component: "marimo-anywidget" },
    { ...report, component: "third-party" },
    { ...report, message: "x".repeat(2001) },
  ];
  for (const value of invalid) {
    Effect.runSync(
      reportOutputError(value).pipe(Effect.provide(Logger.layer([logger]))),
    );
  }
  expect(logs).toEqual([]);
});
