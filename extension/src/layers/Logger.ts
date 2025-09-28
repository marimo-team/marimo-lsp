import * as fs from "node:fs";
import * as path from "node:path";
import { Effect, Layer, Logger, type LogLevel } from "effect";
import { VsCode } from "../services/VsCode.ts";

const makeFileLogger = (logFilePath: string) =>
  Effect.gen(function* () {
    yield* Effect.sync(() =>
      fs.mkdirSync(path.dirname(logFilePath), { recursive: true }),
    );
    const logFile = yield* Effect.acquireRelease(
      Effect.sync(() => fs.openSync(logFilePath, "a", 0o666)),
      (fd) => Effect.sync(() => fs.closeSync(fd)),
    );
    return Logger.map(Logger.logfmtLogger, (str) => {
      fs.writeSync(logFile, `${str}\n`);
    });
  });

const makeVsCodeLogger = (name: string) =>
  Effect.gen(function* () {
    type Level = Exclude<LogLevel.LogLevel["label"], "OFF" | "ALL">;
    const code = yield* VsCode;
    const channel = yield* code.window.createOutputChannel(name);

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

export const LoggerLive = Layer.unwrapScoped(
  Effect.gen(function* () {
    const fileLogger = yield* makeFileLogger(
      path.join(__dirname, "../../logs/marimo.log"),
    );
    const vscodeLogger = yield* makeVsCodeLogger("marimo");
    return Logger.replace(
      Logger.defaultLogger,
      Logger.zip(fileLogger, vscodeLogger),
    );
  }),
);
