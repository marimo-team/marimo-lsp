import {
  Array as ReadonlyArray,
  Cause,
  Context,
  Effect,
  Inspectable,
  Layer,
  Logger,
  type LogLevel,
  Redactable,
  References,
} from "effect";

import { OutputChannel } from "../platform/OutputChannel.ts";
import { Telemetry } from "../telemetry/Telemetry.ts";

const structuredMessage = (u: unknown): unknown => {
  switch (typeof u) {
    case "bigint":
    case "function":
    case "symbol":
      return String(u);
    default:
      return Inspectable.toJson(u);
  }
};

const formatValue = (value: unknown): string => {
  if (Cause.isCause(value)) {
    return value.reasons.length === 0 ? "" : Cause.pretty(value);
  }
  const redacted = Redactable.redact(value);
  return typeof redacted === "string" ? redacted : JSON.stringify(redacted);
};

const makeVsCodeLogger = (
  channel: Context.Service.Shape<typeof OutputChannel>,
) => {
  const mapping = {
    Info: channel.info.bind(channel),
    Trace: channel.trace.bind(channel),
    Debug: channel.debug.bind(channel),
    Warn: channel.warn.bind(channel),
    Error: channel.error.bind(channel),
    Fatal: channel.error.bind(channel),
  } as const satisfies Record<LogLevel.Severity, (message: string) => void>;
  const isSeverity = (level: LogLevel.LogLevel): level is LogLevel.Severity =>
    Object.hasOwn(mapping, level);

  return Logger.make((opts) => {
    const messages = ReadonlyArray.ensure(opts.message);
    const lines: Array<string> = [];

    // First line: inline the first message if it's a string (matches prettyLogger)
    let firstLine = "";
    let messageIndex = 0;
    if (messages.length > 0) {
      const first = structuredMessage(messages[0]);
      if (typeof first === "string") {
        firstLine = first;
        messageIndex = 1;
      }
    }

    // Append spans to first line
    const spans = opts.fiber.getRef(References.CurrentLogSpans);
    if (spans.length > 0) {
      const now = opts.date.getTime();
      const spanParts: Array<string> = [];
      for (const [label, startTime] of spans) {
        spanParts.push(`${label}=${now - startTime}ms`);
      }
      if (firstLine) {
        firstLine += ` (${spanParts.join(", ")})`;
      } else {
        firstLine = spanParts.join(", ");
      }
    }

    lines.push(firstLine);

    // Cause first (matches prettyLogger order)
    if (opts.cause.reasons.length > 0) {
      lines.push(Cause.pretty(opts.cause));
    }

    // Remaining messages
    for (; messageIndex < messages.length; messageIndex++) {
      lines.push(`  ${formatValue(messages[messageIndex])}`);
    }

    // Annotations: inline short values on first line, multi-line values below
    const annotations = Object.entries(
      opts.fiber.getRef(References.CurrentLogAnnotations),
    );
    if (annotations.length > 0) {
      const inline: Array<string> = [];
      for (const [key, value] of annotations) {
        const formatted = formatValue(value);
        if (formatted.includes("\n")) {
          lines.push(`  ${key}: ${formatted}`);
        } else {
          inline.push(`${key}=${formatted}`);
        }
      }
      if (inline.length > 0) {
        lines[0] += ` [${inline.join(", ")}]`;
      }
    }

    const log = isSeverity(opts.logLevel)
      ? mapping[opts.logLevel]
      : channel.info.bind(channel);
    log(lines.join("\n"));
  });
};

/**
 * Adds the identity and the attributes of the current span to the log
 * annotations that the wrapped logger reads.
 *
 * A logger reads its annotations from the fiber and not from
 * `Logger.Options`. This function changes the fiber context before the inner
 * `log` call. It puts the old context back after that call.
 */
export const withSpanAnnotations = <Message, Output>(
  logger: Logger.Logger<Message, Output>,
): Logger.Logger<Message, Output> =>
  Logger.make((options) => {
    const fiber = options.fiber;
    const span = fiber.currentSpan;
    if (span === undefined) {
      return logger.log(options);
    }
    const previous = fiber.context;
    const merged = {
      ...(span._tag === "Span" ? Object.fromEntries(span.attributes) : {}),
      ...fiber.getRef(References.CurrentLogAnnotations),
      // The identity is set last. It replaces a user annotation that has
      // the same name. An `ExternalSpan` has ids but no name.
      "effect.traceId": span.traceId,
      "effect.spanId": span.spanId,
      ...(span._tag === "Span" ? { "effect.spanName": span.name } : {}),
    };
    fiber.setContext(
      Context.add(previous, References.CurrentLogAnnotations, merged),
    );
    try {
      return logger.log(options);
    } finally {
      fiber.setContext(previous);
    }
  });

/**
 * Configures logging for the extension's VS Code output channel and the
 * telemetry error sink.
 */
export const LoggerLive = Layer.unwrap(
  Effect.gen(function* () {
    const outputChannel = yield* OutputChannel;
    const vscodeLogger = makeVsCodeLogger(outputChannel);
    const telemetry = yield* Telemetry;
    return Logger.layer([
      vscodeLogger,
      withSpanAnnotations(telemetry.errorLogger),
      // Keep the tracer logger. Span events must continue to reach the
      // tracer.
      Logger.tracerLogger,
    ]);
  }),
);
