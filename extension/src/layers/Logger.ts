import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { Effect, Layer, Logger, type LogLevel } from "effect";
import { OutputChannel } from "../services/OutputChannel.ts";
import { Sentry } from "../services/Sentry.ts";

const makeFileLogger = (logFilePath: string) =>
  Effect.gen(function* () {
    yield* Effect.sync(() =>
      NodeFs.mkdirSync(NodePath.dirname(logFilePath), { recursive: true }),
    );
    const logFile = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFs.openSync(logFilePath, "a", 0o666)),
      (fd) => Effect.sync(() => NodeFs.closeSync(fd)),
    );
    return Logger.map(Logger.logfmtLogger, (str) => {
      NodeFs.writeSync(logFile, `${str}\n`);
    });
  });

const makeVsCodeLogger = (channel: OutputChannel) =>
  Effect.gen(function* () {
    type Level = Exclude<LogLevel.LogLevel["label"], "OFF" | "ALL">;
    const mapping = {
      INFO: channel.info,
      TRACE: channel.trace,
      DEBUG: channel.debug,
      WARN: channel.warn,
      ERROR: channel.error,
      FATAL: channel.error,
    } as const;
    return Logger.map(Logger.logfmtLogger, (str) => {
      // parse out the level from the default formatter
      const match = str.match(/level=(\w+)\s*(.*)/);
      const [level, message] = match
        ? [match[1] as Level, match[2].trim()]
        : ["INFO" as Level, str];
      const log = mapping[level] ?? channel.info;
      log(message);
    });
  });

/**
 * Configures logging for the extension (both within VS Code and to the file system)
 */
export const LoggerLive = Layer.unwrapScoped(
  Effect.gen(function* () {
    const outputChannel = yield* OutputChannel;
    const fileLogger = yield* makeFileLogger(
      NodePath.join(__dirname, "../../logs/marimo.log"),
    );
    const vscodeLogger = yield* makeVsCodeLogger(outputChannel);
    const sentry = yield* Sentry;
    return Logger.replace(
      Logger.defaultLogger,
      Logger.zip(Logger.zip(fileLogger, vscodeLogger), sentry.errorLogger),
    );
  }),
);
