import {
  Context,
  Data,
  Effect,
  Layer,
  Logger,
  type LogLevel,
  Stream,
} from "effect";
import * as vscode from "vscode";
import type * as lsp from "vscode-languageclient";
import { executeCommand } from "./commands.ts";
import { Logger as VsCodeLogger } from "./logging.ts";

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
        return Effect.tryPromise({
          try: () => executeCommand(client, command),
          catch: (error) => new ExecuteCommandError({ command, error }),
        });
      }

      return {
        client,
        run(params: ParamsFor<"marimo.run">) {
          return exec({ command: "marimo.run", params });
        },
        setUiElementValue(params: ParamsFor<"marimo.set_ui_element_value">) {
          return exec({ command: "marimo.set_ui_element_value", params });
        },
        serialize(params: ParamsFor<"marimo.serialize">) {
          return exec({ command: "marimo.serialize", params });
        },
        deserialize(params: ParamsFor<"marimo.deserialize">) {
          return exec({ command: "marimo.deserialize", params });
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
