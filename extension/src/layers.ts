import * as fs from "node:fs";
import * as path from "node:path";
import { Effect, Layer, Logger, type LogLevel } from "effect";
import { KernelManagerLive } from "./kernelManager.ts";
import { NotebookControllerManager } from "./notebookControllerManager.ts";
import { MarimoDebugAdapter } from "./services/DebugAdapter.ts";
import { MarimoConfig } from "./services/MarimoConfig.ts";
import { MarimoLanguageClient } from "./services/MarimoLanguageClient.ts";
import { MarimoNotebookRenderer } from "./services/MarimoNotebookRenderer.ts";
import { MarimoNotebookSerializer } from "./services/MarimoNotebookSerializer.ts";
import { PythonExtension } from "./services/PythonExtension.ts";
import { VsCode } from "./services/VsCode.ts";

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

const LoggerLive = Layer.unwrapScoped(
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

const CommandsLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const serializer = yield* MarimoNotebookSerializer;
    yield* Effect.logInfo("Setting up commands").pipe(
      Effect.annotateLogs({ component: "commands" }),
    );
    yield* code.commands.registerCommand(
      "marimo.newMarimoNotebook",
      Effect.gen(function* () {
        const doc = yield* code.workspace.createEmptyPythonNotebook(
          serializer.notebookType,
        );
        yield* code.window.use((api) => api.showNotebookDocument(doc));
        yield* Effect.logInfo("Created new marimo notebook").pipe(
          Effect.annotateLogs({
            component: "commands",
            uri: doc.uri.toString(),
          }),
        );
      }),
    );
  }),
);

const ServerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const client = yield* MarimoLanguageClient;
    yield* Effect.logInfo("Starting LSP client").pipe(
      Effect.annotateLogs({ component: "server" }),
    );
    yield* client.manage();
    yield* Effect.logInfo("LSP client started").pipe(
      Effect.annotateLogs({ component: "server" }),
    );
    yield* Effect.logInfo("Extension main fiber running").pipe(
      Effect.annotateLogs({ component: "server" }),
    );
  }).pipe(
    Effect.catchTag("LanguageClientStartError", (error) =>
      Effect.gen(function* () {
        const code = yield* VsCode;
        yield* Effect.logError("Failed to start extension", error).pipe(
          Effect.annotateLogs({ component: "server" }),
        );
        yield* code.window.useInfallable((api) =>
          api.showErrorMessage(
            `Marimo language server failed to start. See marimo logs for more info.`,
          ),
        );
      }),
    ),
  ),
);

export const MainLive = ServerLive.pipe(
  Layer.merge(CommandsLive),
  Layer.merge(KernelManagerLive),
  Layer.provide(MarimoDebugAdapter.Default),
  Layer.provide(MarimoNotebookRenderer.Default),
  Layer.provide(NotebookControllerManager.Default),
  Layer.provide(MarimoNotebookSerializer.Default),
  Layer.provide(PythonExtension.Default),
  Layer.provide(MarimoLanguageClient.Default),
  Layer.provide(MarimoConfig.Default),
  Layer.provide(LoggerLive),
  Layer.provide(VsCode.Default),
);
