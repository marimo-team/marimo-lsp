import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import { Cause, Data, Effect, Option, Stream } from "effect";
import * as lsp from "vscode-languageclient/node";

import { NOTEBOOK_TYPE } from "../constants.ts";
import type {
  MarimoCommand,
  MarimoLspNotification,
  MarimoLspNotificationOf,
} from "../types.ts";
import { acquireDisposable } from "../lib/acquireDisposable.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { tokenFromSignal } from "../lib/tokenFromSignal.ts";
import { Config } from "../config/Config.ts";
import { Uv } from "../python/Uv.ts";
import { VsCode } from "../platform/VsCode.ts";

export class LanguageClientStartError extends Data.TaggedError(
  "LanguageClientStartError",
)<{
  exec: lsp.Executable;
  cause: unknown;
}> {}

export class ExecuteCommandError extends Data.TaggedError(
  "ExecuteCommandError",
)<{
  readonly command: MarimoCommand;
  readonly cause: unknown;
}> {}

/**
 * Manages the marimo LSP client lifecycle and provides
 * methods to interact with the language server (execute commands,
 * send/receive notifications, serialize/deserialize notebooks).
 */
export class LanguageClient extends Effect.Service<LanguageClient>()(
  "LanguageClient",
  {
    dependencies: [Config.Default, Uv.Default],
    scoped: Effect.gen(function* () {
      const uv = yield* Uv;
      const code = yield* VsCode;
      const config = yield* Config;

      const exec = yield* Option.match(yield* config.lsp.executable, {
        onSome: Effect.succeed,
        onNone: () => findLspExecutable(uv.bin.executable),
      });

      yield* Effect.logInfo("Got marimo-lsp executable").pipe(
        Effect.annotateLogs({
          command: exec.command,
          args: (exec.args ?? []).join(" "),
        }),
      );

      const outputChannel =
        yield* code.window.createLogOutputChannel("marimo-lsp");

      const client = new lsp.LanguageClient(
        "marimo-lsp",
        "Marimo Language Server",
        { run: exec, debug: exec },
        {
          // create a dedicated output channel for marimo-lsp messages
          outputChannel,
          revealOutputChannelOn: lsp.RevealOutputChannelOn.Never,
          documentSelector: [
            { notebook: NOTEBOOK_TYPE, language: "sql" },
            { notebook: NOTEBOOK_TYPE, language: "python" },
            { notebook: NOTEBOOK_TYPE, language: "mo-python" },
          ],
        },
      );

      /**
       * Stop the client, with a timeout to avoid hanging indefinitely.
       *
       * Some LSP lifecycle errors occur because `client.stop()` never
       * resolves (e.g. the server process is stuck). A bounded stop
       * prevents the restart flow from blocking forever (VSCODE-MARIMO-2KA).
       */
      const stopClient = Effect.fn(function* () {
        yield* Effect.tryPromise(() => client.stop()).pipe(
          Effect.timeout("5 seconds"),
          Effect.ignore,
        );
        yield* Effect.logInfo("marimo-lsp client stopped");
      });

      /**
       * Start the client. Waits until the client is fully stopped first,
       * avoiding the "Client is currently stopping" race (VSCODE-MARIMO-2KZ).
       */
      const startClient = () =>
        Effect.gen(function* () {
          // If the client is in a "stopping" state, wait for it to finish
          // before attempting to start again.
          if (!client.isRunning() && client.needsStop()) {
            yield* Effect.logInfo(
              "Client is still stopping, waiting before start",
            );
            yield* stopClient();
          }
          yield* Effect.tryPromise({
            try: () => client.start(),
            catch: (cause) => new LanguageClientStartError({ exec, cause }),
          });
          yield* Effect.logInfo("marimo-lsp client started");
        }).pipe(Effect.withSpan("lsp.start"));

      // Register cleanup when scope closes
      yield* Effect.addFinalizer(() => Effect.promise(() => client.dispose()));

      return {
        channel: {
          name: outputChannel.name,
          show: outputChannel.show.bind(outputChannel),
        },
        restart: () =>
          code.window.withProgress(
            {
              location: code.ProgressLocation.Notification,
              title: "Restarting marimo-lsp",
              cancellable: true,
            },
            Effect.fn(function* (progress) {
              if (client.isRunning()) {
                progress.report({ message: "Stopping..." });
                yield* stopClient();
              }
              progress.report({ message: "Starting..." });
              yield* startClient().pipe(
                Effect.catchTag(
                  "LanguageClientStartError",
                  Effect.fn(function* (error) {
                    const msg = "Failed to restart marimo-lsp.";
                    yield* Effect.logError(msg).pipe(
                      Effect.annotateLogs({ cause: Cause.fail(error) }),
                    );
                    yield* showErrorAndPromptLogs(msg, {
                      channel: outputChannel,
                    });
                  }),
                ),
              );
              progress.report({ message: "Done." });
            }),
          ),
        executeCommand: Effect.fn(function* (cmd: MarimoCommand) {
          if (!client.isRunning()) {
            yield* startClient();
          }
          return yield* Effect.tryPromise({
            try: (signal) =>
              client.sendRequest<unknown>(
                "workspace/executeCommand",
                { command: cmd.command, arguments: [cmd.params] },
                tokenFromSignal(signal),
              ),
            catch: (cause) => new ExecuteCommandError({ command: cmd, cause }),
          }).pipe(
            Effect.withSpan("lsp.executeCommand", {
              attributes: {
                command: cmd.command,
                method:
                  "params" in cmd && cmd.params && "method" in cmd.params
                    ? cmd.params.method
                    : undefined,
              },
            }),
          );
        }),
        streamOf<Notification extends MarimoLspNotification>(
          notification: Notification,
        ) {
          return Stream.asyncPush<MarimoLspNotificationOf<Notification>>(
            (emit) =>
              acquireDisposable(() =>
                client.onNotification(notification, (msg) => {
                  emit.single(msg);
                }),
              ),
          );
        },
      };
    }),
  },
) {}

export const findLspExecutable = Effect.fn("findLspExecutable")(function* (
  uvBinary: string,
) {
  // Look for bundled wheel matching marimo_lsp-* pattern
  const sdistDir = NodeFs.readdirSync(__dirname).find((f) =>
    f.startsWith("marimo_lsp-"),
  );

  if (sdistDir) {
    const sdist = NodePath.join(__dirname, sdistDir);
    yield* Effect.logInfo("Using bundled marimo-lsp").pipe(
      Effect.annotateLogs({ sdist }),
    );
    return {
      command: uvBinary,
      args: ["tool", "run", "--python", "3.13", "--from", sdist, "marimo-lsp"],
    };
  }

  // Fallback to development mode if no wheel found
  yield* Effect.logWarning("No bundled wheel found, using development mode");

  return {
    command: uvBinary,
    args: ["run", "--directory", __dirname, "marimo-lsp"],
  };
});
