import {
  Array as ReadonlyArray,
  Cause,
  Effect,
  HashMap,
  Inspectable,
  Layer,
  List,
  Logger,
  type LogLevel,
} from "effect";

import { OutputChannel } from "../platform/OutputChannel.ts";
import { Sentry } from "../telemetry/Sentry.ts";

const structuredMessage = (u: unknown): unknown => {
  switch (typeof u) {
    case "bigint":
    case "function":
    case "symbol":
      return String(u);
    default:
      return Inspectable.toJSON(u);
  }
};

const formatValue = (value: unknown): string => {
  if (Cause.isCause(value)) {
    return Cause.isEmpty(value)
      ? ""
      : Cause.pretty(value, { renderErrorCause: true });
  }
  const redacted = Inspectable.redact(value);
  return typeof redacted === "string" ? redacted : JSON.stringify(redacted);
};

const makeVsCodeLogger = (channel: OutputChannel) => {
  type Level = Exclude<LogLevel.LogLevel["label"], "OFF" | "ALL">;
  const mapping = {
    INFO: channel.info.bind(channel),
    TRACE: channel.trace.bind(channel),
    DEBUG: channel.debug.bind(channel),
    WARN: channel.warn.bind(channel),
    ERROR: channel.error.bind(channel),
    FATAL: channel.error.bind(channel),
  } as const;
  const isLevel = (label: string): label is Level =>
    Object.hasOwn(mapping, label);

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
    if (List.isCons(opts.spans)) {
      const now = opts.date.getTime();
      const spanParts: Array<string> = [];
      for (const span of opts.spans) {
        spanParts.push(`${span.label}=${now - span.startTime}ms`);
      }
      if (firstLine) {
        firstLine += ` (${spanParts.join(", ")})`;
      } else {
        firstLine = spanParts.join(", ");
      }
    }

    lines.push(firstLine);

    // Cause first (matches prettyLogger order)
    if (!Cause.isEmpty(opts.cause)) {
      lines.push(Cause.pretty(opts.cause, { renderErrorCause: true }));
    }

    // Remaining messages
    for (; messageIndex < messages.length; messageIndex++) {
      lines.push(`  ${formatValue(messages[messageIndex])}`);
    }

    // Annotations: inline short values on first line, multi-line values below
    if (HashMap.size(opts.annotations) > 0) {
      const inline: Array<string> = [];
      for (const [key, value] of opts.annotations) {
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

    const log = isLevel(opts.logLevel.label)
      ? mapping[opts.logLevel.label]
      : channel.info.bind(channel);
    log(lines.join("\n"));
  });
};

/**
 * Configures logging for the extension's VS Code output channel and Sentry.
 */
export const LoggerLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const outputChannel = yield* OutputChannel;
    const vscodeLogger = makeVsCodeLogger(outputChannel);
    const sentry = yield* Sentry;
    return Logger.replace(
      Logger.defaultLogger,
      Logger.zip(vscodeLogger, Logger.withSpanAnnotations(sentry.errorLogger)),
    );
  }),
);
