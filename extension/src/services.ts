import {
  Context,
  Data,
  Effect,
  FiberSet,
  Layer,
  Logger,
  LogLevel,
  type ParseResult,
  Schema,
  Stream,
} from "effect";
import * as vscode from "vscode";
import * as lsp from "vscode-languageclient/node";
import { executeCommand, registerCommand } from "./commands.ts";
import { DebugAdapterLive } from "./debugAdapter.ts";
import { getLspExecutable } from "./languageClient.ts";
import { channel, Logger as VsCodeLogger } from "./logging.ts";
import { NotebookSerializationSchema } from "./schemas.ts";
import {
  type MarimoCommand,
  type MarimoNotification,
  type MarimoNotificationOf,
  notebookType,
  type RendererCommand,
  type RendererReceiveMessage,
} from "./types.ts";

type ParamsFor<Command extends MarimoCommand["command"]> = Extract<
  MarimoCommand,
  { command: Command }
>["params"];

export class OutputChannel extends Context.Tag("OutputChannel")<
  OutputChannel,
  vscode.OutputChannel
>() {
  static layer = (channel: vscode.OutputChannel) =>
    Layer.succeed(this, channel);
}

class ExecuteCommandError extends Data.TaggedError("ExecuteCommandError")<{
  readonly command: MarimoCommand;
  readonly error: unknown;
}> {}

export class MarimoLanguageClient extends Effect.Service<MarimoLanguageClient>()(
  "MarimoLanguageClient",
  {
    effect: Effect.gen(function* () {
      const client = yield* BaseLanguageClient;

      function exec(command: MarimoCommand) {
        return Effect.withSpan(command.command)(
          Effect.tryPromise({
            try: (signal) => {
              const source = new vscode.CancellationTokenSource();
              if (signal.aborted) {
                source.cancel();
              }
              signal.addEventListener("abort", () => {
                source.cancel();
              });
              return executeCommand(client, {
                ...command,
                token: source.token,
              }).finally(() => {
                source.dispose();
              });
            },
            catch: (error) => new ExecuteCommandError({ command, error }),
          }),
        );
      }

      return {
        client,
        run(params: ParamsFor<"marimo.run">) {
          return exec({ command: "marimo.run", params });
        },
        setUiElementValue(params: ParamsFor<"marimo.set_ui_element_value">) {
          return exec({ command: "marimo.set_ui_element_value", params });
        },
        interrupt(params: ParamsFor<"marimo.interrupt">) {
          return exec({ command: "marimo.interrupt", params });
        },
        dap(params: ParamsFor<"marimo.dap">) {
          return exec({ command: "marimo.dap", params });
        },
        serialize(
          params: vscode.NotebookData,
        ): Effect.Effect<
          Uint8Array,
          ExecuteCommandError | ParseResult.ParseError,
          never
        > {
          const { cells, metadata = {} } = params;
          return Effect.gen(function* () {
            const notebook = yield* Schema.decodeUnknown(
              NotebookSerializationSchema,
            )({
              app: metadata.app ?? { options: {} },
              header: metadata.header ?? null,
              version: metadata.version ?? null,
              violations: metadata.violations ?? [],
              valid: metadata.valid ?? true,
              cells: cells.map((cell) => ({
                code: cell.value,
                name: cell.metadata?.name ?? "_",
                options: cell.metadata?.options ?? {},
              })),
            });
            return yield* exec({
              command: "marimo.serialize",
              params: { notebook },
            }).pipe(
              Effect.andThen(
                Schema.decodeUnknown(Schema.Struct({ source: Schema.String })),
              ),
              Effect.andThen(({ source }) => new TextEncoder().encode(source)),
            );
          });
        },
        deserialize(
          buf: Uint8Array,
        ): Effect.Effect<
          vscode.NotebookData,
          ExecuteCommandError | ParseResult.ParseError,
          never
        > {
          return exec({
            command: "marimo.deserialize",
            params: { source: new TextDecoder().decode(buf) },
          }).pipe(
            Effect.andThen(Schema.decodeUnknown(NotebookSerializationSchema)),
            Effect.andThen(({ cells, ...metadata }) => ({
              metadata: metadata,
              cells: cells.map((cell) => ({
                kind: vscode.NotebookCellKind.Code,
                value: cell.code,
                languageId: "python",
                metadata: {
                  name: cell.name,
                  options: cell.options,
                },
              })),
            })),
          );
        },
        streamOf<Notification extends MarimoNotification>(
          notification: Notification,
        ): Stream.Stream<MarimoNotificationOf<Notification>, never, never> {
          return Stream.asyncPush((emit) =>
            Effect.acquireRelease(
              Effect.sync(() =>
                client.onNotification(notification, emit.single.bind(emit)),
              ),
              (disposable) => Effect.sync(() => disposable.dispose()),
            ),
          );
        },
      };
    }),
  },
) {}

export class MarimoNotebookRenderer extends Effect.Service<MarimoNotebookRenderer>()(
  "MarimoNotebookRenderer",
  {
    sync: () => {
      const channel =
        vscode.notebooks.createRendererMessaging("marimo-renderer");
      return {
        postMessage(
          message: RendererReceiveMessage,
          editor?: vscode.NotebookEditor,
        ): Effect.Effect<boolean, never, never> {
          return Effect.promise(() => channel.postMessage(message, editor));
        },
        messages() {
          return Stream.asyncPush<{
            editor: vscode.NotebookEditor;
            message: RendererCommand;
          }>(
            Effect.fnUntraced(function* (emit) {
              const disposer = channel.onDidReceiveMessage((msg) =>
                emit.single(msg),
              );
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => disposer.dispose()),
              );
            }),
          );
        },
      };
    },
  },
) {}

export class MarimoConfig extends Effect.Service<MarimoConfig>()(
  "MarimoConfig",
  {
    sync: () => ({
      get lsp() {
        return {
          get executable(): undefined | { command: string; args: string[] } {
            const lspPath = vscode.workspace
              .getConfiguration("marimo.lsp")
              .get<string[]>("path", []);
            if (!lspPath || lspPath.length === 0) {
              return undefined;
            }
            const [command, ...args] = lspPath;
            return { command, args };
          },
        };
      },
    }),
  },
) {}

// Map effect's formatted messages to our logging system
export const LoggerLive = Logger.replace(
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

export function runPromise<A, E>(
  e: Effect.Effect<A, E>,
  options: { readonly signal?: AbortSignal } = {},
): Promise<A> {
  // We just forward everything since the VsCodeLogger automatically filters
  return Effect.runPromise(
    e.pipe(Logger.withMinimumLogLevel(LogLevel.All)),
    options,
  );
}

export class BaseLanguageClient extends Effect.Service<BaseLanguageClient>()(
  "BaseLanguageClient",
  {
    effect: Effect.gen(function* () {
      const channel = yield* OutputChannel;
      const exec = yield* getLspExecutable();
      yield* Effect.logInfo(
        `Starting language server with command: ${exec.command} ${(exec.args ?? []).join(" ")}`,
      );
      return new lsp.LanguageClient(
        "marimo-lsp",
        "Marimo Language Server",
        { run: exec, debug: exec },
        {
          outputChannel: channel,
          revealOutputChannelOn: lsp.RevealOutputChannelOn.Never,
        },
      );
    }),
  },
) {}

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
            runFork(mapping[type](message)),
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

export const MainLive = LoggerLive.pipe(
  Layer.merge(CommandsLive),
  Layer.merge(DebugAdapterLive),
  Layer.merge(LspLogForwardingLive),
  Layer.merge(MarimoNotebookSerializerLive),
  Layer.merge(MarimoNotebookRenderer.Default),
  Layer.provide(MarimoLanguageClient.Default),
  Layer.provideMerge(BaseLanguageClient.Default),
  Layer.provide(MarimoConfig.Default),
  Layer.provide(OutputChannel.layer(channel)),
);
