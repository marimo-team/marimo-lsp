import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { Data, Effect, Option, type Scope, Stream } from "effect";
import * as lsp from "vscode-languageclient/node";
import type {
  MarimoCommand,
  MarimoNotification,
  MarimoNotificationOf,
} from "../types.ts";
import { tokenFromSignal } from "../utils/tokenFromSignal.ts";
import { Config } from "./Config.ts";
import { VsCode } from "./VsCode.ts";

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
    dependencies: [VsCode.Default, Config.Default],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const config = yield* Config;

      const exec = yield* Option.match(yield* config.lsp.executable, {
        onSome: Effect.succeed,
        onNone: findLspExecutable,
      });

      yield* Effect.logInfo("Got marimo-lsp executable").pipe(
        Effect.annotateLogs({
          command: exec.command,
          args: (exec.args ?? []).join(" "),
        }),
      );

      const client = new lsp.LanguageClient(
        "marimo-lsp",
        "Marimo Language Server",
        { run: exec, debug: exec },
        {
          // create a dedicated output channel for marimo-lsp messages
          outputChannel: yield* code.window.createOutputChannel("marimo-lsp"),
          revealOutputChannelOn: lsp.RevealOutputChannelOn.Never,
        },
      );

      return {
        manage() {
          return Effect.acquireRelease(
            Effect.tryPromise({
              try: () => client.start(),
              catch: (cause) => new LanguageClientStartError({ exec, cause }),
            }),
            () => Effect.sync(() => client.dispose()),
          );
        },
        executeCommand(
          cmd: MarimoCommand,
        ): Effect.Effect<unknown, ExecuteCommandError, never> {
          return Effect.tryPromise({
            try: (signal) =>
              client.sendRequest<unknown>(
                "workspace/executeCommand",
                {
                  command: cmd.command,
                  arguments: [cmd.params],
                },
                tokenFromSignal(signal),
              ),
            catch: (cause) => new ExecuteCommandError({ command: cmd, cause }),
          });
        },
        streamOf<Notification extends MarimoNotification>(
          notification: Notification,
        ): Stream.Stream<
          MarimoNotificationOf<Notification>,
          never,
          Scope.Scope
        > {
          return Stream.asyncPush((emit) =>
            Effect.acquireRelease(
              Effect.sync(() =>
                client.onNotification(notification, (msg) => emit.single(msg)),
              ),
              (disposable) => Effect.sync(() => disposable.dispose()),
            ),
          );
        },
      };
    }),
  },
) {}

export const findLspExecutable = Effect.fnUntraced(function* () {
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
      command: "uv",
      args: ["tool", "run", "--from", sdist, "marimo-lsp"],
    };
  }

  // Fallback to development mode if no wheel found
  yield* Effect.logWarning("No bundled wheel found, using development mode");

  return {
    command: "uv",
    args: ["run", "--directory", __dirname, "marimo-lsp"],
  };
});
