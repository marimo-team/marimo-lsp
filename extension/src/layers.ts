import * as fs from "node:fs";
import * as path from "node:path";
import { Effect, FiberSet, Layer, Logger, type LogLevel } from "effect";
import * as vscode from "vscode";
import { registerCommand } from "./commands.ts";
import { DebugAdapterLive } from "./debugAdapter.ts";
import { KernelManagerLive } from "./kernelManager.ts";
import { Logger as VsCodeLogger } from "./logging.ts";
import { NotebookControllerManager } from "./notebookControllerManager.ts";
import { MarimoConfig } from "./services/MarimoConfig.ts";
import { MarimoLanguageClient } from "./services/MarimoLanguageClient.ts";
import { MarimoNotebookRenderer } from "./services/MarimoNotebookRenderer.ts";
import { PythonExtension } from "./services/PythonExtension.ts";
import { notebookType } from "./types.ts";

const LoggerLive = Layer.unwrapScoped(
  Effect.gen(function* () {
    const logFilePath = path.join(__dirname, "../../logs/marimo.log");
    const fileLogger = yield* Effect.gen(function* () {
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

    // Map the formatted message to vscode method
    const vscodeLogger = Logger.map(Logger.logfmtLogger, (str) => {
      const match = str.match(/level=(\w+)\s*(.*)/);
      const [level, message] = match
        ? [match[1], match[2].trim()]
        : ["INFO", str];
      const mapping = {
        TRACE: VsCodeLogger.trace,
        DEBUG: VsCodeLogger.debug,
        INFO: VsCodeLogger.info,
        WARN: VsCodeLogger.warn,
        ERROR: VsCodeLogger.error,
        FATAL: VsCodeLogger.error,
      } satisfies Partial<Record<LogLevel.LogLevel["label"], unknown>>;

      // @ts-expect-error - We have a fallback
      const log = mapping[level] || VsCodeLogger.info;
      log(message);
    });

    return Logger.replace(
      Logger.defaultLogger,
      Logger.zip(fileLogger, vscodeLogger),
    );
  }),
);

const CommandsLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    yield* Effect.logInfo("Setting up commands").pipe(
      Effect.annotateLogs({ component: "commands" }),
    );
    const runForkPromise = yield* FiberSet.makeRuntimePromise();

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        registerCommand("marimo.newMarimoNotebook", () =>
          runForkPromise(
            Effect.gen(function* () {
              const doc = yield* Effect.tryPromise(() =>
                vscode.workspace.openNotebookDocument(
                  notebookType,
                  new vscode.NotebookData([
                    new vscode.NotebookCellData(
                      vscode.NotebookCellKind.Code,
                      "",
                      "python",
                    ),
                  ]),
                ),
              );
              yield* Effect.tryPromise(() =>
                vscode.window.showNotebookDocument(doc),
              );
              yield* Effect.logInfo("Created new marimo notebook").pipe(
                Effect.annotateLogs({
                  component: "commands",
                  uri: doc.uri.toString(),
                }),
              );
            }),
          ),
        ),
      ),
      (disposable) => Effect.sync(() => disposable.dispose()),
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
        yield* Effect.logError("Failed to start extension", error).pipe(
          Effect.annotateLogs({ component: "server" }),
        );
        yield* Effect.promise(() =>
          vscode.window.showErrorMessage(
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
  Layer.provide(LoggerLive),
);
