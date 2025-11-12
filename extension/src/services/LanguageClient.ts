import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { Data, Effect, Either, Option, Stream } from "effect";
import * as lsp from "vscode-languageclient/node";
import { unreachable } from "../assert.ts";
import type {
  MarimoCommand,
  MarimoNotification,
  MarimoNotificationOf,
} from "../types.ts";
import { showErrorAndPromptLogs } from "../utils/showErrorAndPromptLogs.ts";
import { tokenFromSignal } from "../utils/tokenFromSignal.ts";
import { Config } from "./Config.ts";
import { OutputChannel } from "./OutputChannel.ts";
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
      const channel = yield* OutputChannel;

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
        },
      );

      const startClient = () =>
        Effect.gen(function* () {
          yield* Effect.logInfo("Starting marimo-lsp client");
          yield* Effect.tryPromise({
            try: () => client.start(),
            catch: (cause) => new LanguageClientStartError({ exec, cause }),
          });
          yield* Effect.logInfo("marimo-lsp client started");
        }).pipe(
          Effect.catchTag(
            "LanguageClientStartError",
            maybeHandleLanguageClientStartError,
          ),
          Effect.provideService(VsCode, code),
          Effect.provideService(OutputChannel, channel),
        );

      // Register cleanup when scope closes
      yield* Effect.addFinalizer(() => Effect.promise(() => client.dispose()));

      return {
        channel: {
          name: outputChannel.name,
          show: outputChannel.show.bind(outputChannel),
        },
        restart: code.window.withProgress(
          {
            location: code.ProgressLocation.Notification,
            title: "Restarting marimo-lsp",
            cancellable: true,
          },
          Effect.fnUntraced(function* (progress) {
            if (client.isRunning()) {
              progress.report({ message: "Stopping..." });
              yield* Effect.promise(() => client.stop());
            }
            progress.report({ message: "Starting..." });
            yield* startClient().pipe(
              Effect.catchTag(
                "LanguageClientStartError",
                Effect.fnUntraced(function* (error) {
                  const msg = "Failed to restart marimo-lsp.";
                  yield* Effect.logError(msg, error);
                  yield* showErrorAndPromptLogs(msg, { code, channel });
                }),
              ),
            );
            progress.report({ message: "Done." });
          }),
        ),
        executeCommand: Effect.fnUntraced(function* (cmd: MarimoCommand) {
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
          });
        }),
        streamOf<Notification extends MarimoNotification>(
          notification: Notification,
        ) {
          return Stream.asyncPush<MarimoNotificationOf<Notification>>((emit) =>
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
      args: ["tool", "run", "--python", "3.13", "--from", sdist, "marimo-lsp"],
    };
  }

  // Fallback to development mode if no wheel found
  yield* Effect.logWarning("No bundled wheel found, using development mode");

  return {
    command: "uv",
    args: ["run", "--directory", __dirname, "marimo-lsp"],
  };
});

export function isUvInstalled(): boolean {
  try {
    NodeChildProcess.execSync("uv --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function maybeHandleLanguageClientStartError(error: LanguageClientStartError) {
  return Effect.gen(function* () {
    const code = yield* VsCode;
    const channel = yield* OutputChannel;

    yield* Effect.logError("Failed to start marimo-lsp", error);

    if (error.exec.command === "uv" && !isUvInstalled()) {
      yield* Effect.logError("uv is not installed in PATH");

      const result = yield* code.window.showErrorMessage(
        "The marimo VS Code extension currently requires uv to be installed.",
        {
          items: ["Install uv", "Try Again"],
        },
      );

      if (Option.isNone(result)) {
        // dismissed
        return yield* Effect.fail(error);
      }

      switch (result.value) {
        case "Install uv": {
          const uri = Either.getOrThrow(
            code.utils.parseUri(
              "https://docs.astral.sh/uv/getting-started/installation/",
            ),
          );
          yield* code.env.openExternal(uri);
          return yield* Effect.fail(error);
        }
        case "Try Again": {
          yield* code.commands.executeCommand("marimo.restartLsp");
          return yield* Effect.fail(error);
        }
        default:
          unreachable(result.value);
      }
    }

    // Otherwise just fail
    const msg = "marimo-lsp failed to start.";
    yield* showErrorAndPromptLogs(msg, { code, channel });
    return yield* Effect.die(msg);
  });
}
