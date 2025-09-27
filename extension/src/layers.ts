import { Effect, FiberSet, Layer, Logger, type LogLevel } from "effect";
import * as vscode from "vscode";
import * as lsp from "vscode-languageclient/node";
import { registerCommand } from "./commands.ts";
import { DebugAdapterLive } from "./debugAdapter.ts";
import { KernelManagerLive } from "./kernelManager.ts";
import { channel, Logger as VsCodeLogger } from "./logging.ts";
import { NotebookControllerManager } from "./notebookControllerManager.ts";
import { BaseLanguageClient } from "./services/BaseLanguageClient.ts";
import { MarimoConfig } from "./services/MarimoConfig.ts";
import { MarimoLanguageClient } from "./services/MarimoLanguageClient.ts";
import { MarimoNotebookRenderer } from "./services/MarimoNotebookRenderer.ts";
import { OutputChannel } from "./services/OutputChannel.ts";
import { PythonExtension } from "./services/PythonExtension.ts";
import { notebookType } from "./types.ts";

// Map effect's formatted messages to our logging system
const LoggerLive = Logger.replace(
  Logger.defaultLogger,
  Logger.map(Logger.logfmtLogger, (formatted) => {
    const match = formatted.match(/level=(\w+)\s*(.*)/);
    const [level, message] = match
      ? [match[1], match[2].trim()]
      : ["INFO", formatted];

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
  }),
);

const LspLogForwardingLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const client = yield* BaseLanguageClient;
    const runFork = yield* FiberSet.makeRuntime();

    const mapping = {
      [lsp.MessageType.Error]: Effect.logError,
      [lsp.MessageType.Warning]: Effect.logWarning,
      [lsp.MessageType.Info]: Effect.logInfo,
      [lsp.MessageType.Log]: Effect.log,
      [lsp.MessageType.Debug]: Effect.logDebug,
    } as const;

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        client.onNotification(
          "window/logMessage",
          ({ type, message }: lsp.LogMessageParams) =>
            runFork(
              mapping[type]("marimo-lsp\n", message.split("\n").join("\n  ")),
            ),
        ),
      ),
      (disposable) => Effect.sync(() => disposable.dispose()),
    );
  }),
);

const CommandsLive = Layer.scopedDiscard(
  Effect.gen(function* () {
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
    const marimo = yield* MarimoLanguageClient;
    const runPromise = yield* FiberSet.makeRuntimePromise();
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vscode.workspace.registerNotebookSerializer(notebookType, {
          serializeNotebook(
            notebook: vscode.NotebookData,
            _token: vscode.CancellationToken,
          ): Promise<Uint8Array> {
            return Effect.gen(function* () {
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
                  new Error(`Notebook serialize failed. See logs for details.`),
              ),
              runPromise,
            );
          },
          deserializeNotebook(
            bytes: Uint8Array,
            _token: vscode.CancellationToken,
          ): Promise<vscode.NotebookData> {
            return Effect.gen(function* () {
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
              runPromise,
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
    const client = yield* BaseLanguageClient;
    yield* Effect.logInfo("Starting LSP client");
    yield* client.manage();
    yield* Effect.logInfo("Started LSP client");
    yield* Effect.logInfo("Extension main fiber running");
  }).pipe(
    Effect.catchTag("LanguageClientStartError", (error) =>
      Effect.gen(function* () {
        yield* Effect.logError("Failed to start extension", error);
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
  Layer.merge(LspLogForwardingLive),
  Layer.merge(MarimoNotebookSerializerLive),
  Layer.merge(KernelManagerLive),
  Layer.provide(LoggerLive),
  Layer.provide(MarimoNotebookRenderer.Default),
  Layer.provide(NotebookControllerManager.Default),
  Layer.provide(PythonExtension.Default),
  Layer.provide(MarimoLanguageClient.Default),
  Layer.provide(BaseLanguageClient.Default),
  Layer.provide(MarimoConfig.Default),
  Layer.provide(OutputChannel.layer(channel)),
);
