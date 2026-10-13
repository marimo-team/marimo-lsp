import { Cause, Effect, Option, Schema } from "effect";

export const OutputError = Schema.Struct({
  component: Schema.String.check(Schema.isMaxLength(100)),
  name: Schema.String.check(Schema.isMaxLength(100)),
  message: Schema.String.check(Schema.isMaxLength(2000)),
  stack: Schema.String.check(Schema.isMaxLength(16000)),
  componentStack: Schema.String.check(Schema.isMaxLength(8000)),
});
export type OutputError = typeof OutputError.Type;

const decode = Schema.decodeUnknownOption(OutputError);

/** Uses the existing consent-gated Effect logger → VS Code → Sentry path. */
export const reportOutputError = Effect.fn("telemetry.reportOutputError")(
  function* (value: unknown) {
    const decoded = decode(value);
    if (Option.isNone(decoded)) return;
    const report = decoded.value;
    if (
      !report.component.startsWith("marimo-") ||
      report.component === "marimo-anywidget"
    )
      return;
    const error = new Error(report.message);
    error.name = report.name;
    // Preserve the renderer stack; an extension-host stack would misattribute
    // the failure to the message bridge rather than the broken component.
    error.stack = report.stack || undefined;
    yield* Effect.logError(
      "Marimo output rendering failed",
      Cause.fail(error),
    ).pipe(
      Effect.annotateLogs({
        "error.domain": "renderer.output",
        "renderer.component": report.component,
        "renderer.component_stack": report.componentStack,
      }),
    );
  },
);
