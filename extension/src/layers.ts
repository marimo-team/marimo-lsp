import * as fs from "node:fs";
import * as path from "node:path";
import { Effect, FiberSet, Layer, Logger, type LogLevel } from "effect";
import * as vscode from "vscode";
import { DebugAdapterLive } from "./debugAdapter.ts";
import { KernelManagerLive } from "./kernelManager.ts";
import { NotebookControllerManager } from "./notebookControllerManager.ts";
import { MarimoConfig } from "./services/MarimoConfig.ts";
import { MarimoLanguageClient } from "./services/MarimoLanguageClient.ts";
import { MarimoNotebookRenderer } from "./services/MarimoNotebookRenderer.ts";
import { PythonExtension } from "./services/PythonExtension.ts";
import { VsCodeCommands } from "./services/VsCodeCommands.ts";
import { VsCodeWindow } from "./services/VsCodeWindow.ts";
import { VsCodeWorkspace } from "./services/VsCodeWorkspace.ts";
import { notebookType } from "./types.ts";

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

    const win = yield* VsCodeWindow;
    const channel = yield* win.createOutputChannel(name);

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
    const win = yield* VsCodeWindow;
    const cmds = yield* VsCodeCommands;
    const workspace = yield* VsCodeWorkspace;
    yield* Effect.logInfo("Setting up commands").pipe(
      Effect.annotateLogs({ component: "commands" }),
    );
    yield* cmds.registerCommand(
      "marimo.newMarimoNotebook",
      Effect.gen(function* () {
        const doc = yield* workspace.createEmptyMarimoNotebook();
        yield* win.use((api) => api.showNotebookDocument(doc));
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

const MarimoNotebookSerializerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    yield* Effect.logInfo("Setting up notebook serializer").pipe(
      Effect.annotateLogs({ component: "notebook-serializer" }),
    );
    const marimo = yield* MarimoLanguageClient;
    const runPromise = yield* FiberSet.makeRuntimePromise();

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vscode.workspace.registerNotebookSerializer(notebookType, {
          serializeNotebook(
            notebook: vscode.NotebookData,
          ): Promise<Uint8Array> {
            return runPromise(
              Effect.gen(function* () {
                yield* Effect.logDebug("Serializing notebook").pipe(
                  Effect.annotateLogs({ cellCount: notebook.cells.length }),
                );
                const bytes = yield* marimo.serialize(notebook);
                yield* Effect.logDebug("Serialization complete").pipe(
                  Effect.annotateLogs({ bytes: bytes.length }),
                );
                return bytes;
              }).pipe(
                Effect.tapError((error) =>
                  Effect.logError(`Notebook serialize failed.`, error),
                ),
                Effect.mapError(
                  () =>
                    new Error(
                      `Notebook serialize failed. See logs for details.`,
                    ),
                ),
              ),
            );
          },
          deserializeNotebook(bytes: Uint8Array): Promise<vscode.NotebookData> {
            return runPromise(
              Effect.gen(function* () {
                yield* Effect.logDebug("Deserializing notebook").pipe(
                  Effect.annotateLogs({ bytes: bytes.length }),
                );
                const notebook = yield* marimo.deserialize(bytes);
                yield* Effect.logDebug("Deserialization complete").pipe(
                  Effect.annotateLogs({ cellCount: notebook.cells.length }),
                );
                return notebook;
              }).pipe(
                Effect.tapError((error) =>
                  Effect.logError(`Notebook deserialize failed.`, error),
                ),
                Effect.mapError(
                  () =>
                    new Error(
                      `Notebook deserialize failed. See logs for details.`,
                    ),
                ),
              ),
            );
          },
        }),
      ),
      (disposable) => Effect.sync(() => disposable.dispose()),
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
        const win = yield* VsCodeWindow;
        yield* Effect.logError("Failed to start extension", error).pipe(
          Effect.annotateLogs({ component: "server" }),
        );
        yield* win.useInfallable((api) =>
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
  Layer.merge(DebugAdapterLive),
  Layer.merge(MarimoNotebookSerializerLive),
  Layer.merge(KernelManagerLive),
  Layer.provide(MarimoNotebookRenderer.Default),
  Layer.provide(NotebookControllerManager.Default),
  Layer.provide(PythonExtension.Default),
  Layer.provide(MarimoLanguageClient.Default),
  Layer.provide(MarimoConfig.Default),
  // Logging
  Layer.provide(LoggerLive),
  // VsCode
  Layer.provide(VsCodeWindow.Default),
  Layer.provide(VsCodeCommands.Default),
  Layer.provide(VsCodeWorkspace.Default),
);
