import {
  Context,
  Data,
  Effect,
  Layer,
  Logger,
  LogLevel,
  type ParseResult,
  Schema,
  Stream,
} from "effect";
import * as vscode from "vscode";
import type * as lsp from "vscode-languageclient";
import { executeCommand } from "./commands.ts";
import { Logger as VsCodeLogger } from "./logging.ts";
import { NotebookSerializationSchema } from "./schemas.ts";
import type {
  MarimoCommand,
  MarimoNotification,
  MarimoNotificationOf,
  RendererCommand,
  RendererReceiveMessage,
} from "./types.ts";

type ParamsFor<Command extends MarimoCommand["command"]> = Extract<
  MarimoCommand,
  { command: Command }
>["params"];

export class RawLanguageClient extends Context.Tag("LanguageClient")<
  RawLanguageClient,
  lsp.BaseLanguageClient
>() {
  static layer = (client: lsp.BaseLanguageClient) =>
    Layer.succeed(this, client);
}

class ExecuteCommandError extends Data.TaggedError("ExecuteCommandError")<{
  readonly command: MarimoCommand;
  readonly error: unknown;
}> {}

export class MarimoLanguageClient extends Effect.Service<MarimoLanguageClient>()(
  "MarimoLanguageClient",
  {
    effect: Effect.gen(function* () {
      const client = yield* RawLanguageClient;

      function exec(command: MarimoCommand) {
        return Effect.withSpan(command.command)(
          Effect.tryPromise({
            try: (signal) => {
              const source = new vscode.CancellationTokenSource();
              if (signal.aborted) source.cancel();
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
          return Stream.asyncPush<MarimoNotificationOf<Notification>>(
            Effect.fnUntraced(function* (emit) {
              const disposer = client.onNotification(
                notification,
                emit.single.bind(emit),
              );
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => disposer.dispose()),
              );
            }),
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
