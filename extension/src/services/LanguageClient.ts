import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { Data, Effect, Either, Option, Stream } from "effect";
import * as lsp from "vscode-languageclient/node";
import { unreachable } from "../assert.ts";
import { NOTEBOOK_TYPE } from "../constants.ts";
import type {
  MarimoCommand,
  MarimoLspNotification,
  MarimoLspNotificationOf,
} from "../types.ts";
import { showErrorAndPromptLogs } from "../utils/showErrorAndPromptLogs.ts";
import { tokenFromSignal } from "../utils/tokenFromSignal.ts";
import { Config } from "./Config.ts";
import { OutputChannel } from "./OutputChannel.ts";
import { Uv } from "./Uv.ts";
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
    dependencies: [VsCode.Default, Config.Default, Uv.Default],
    scoped: Effect.gen(function* () {
      const uv = yield* Uv;
      const code = yield* VsCode;
      const config = yield* Config;
      const channel = yield* OutputChannel;

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
        streamOf<Notification extends MarimoLspNotification>(
          notification: Notification,
        ) {
          return Stream.asyncPush<MarimoLspNotificationOf<Notification>>(
            (emit) =>
              Effect.acquireRelease(
                Effect.sync(() =>
                  client.onNotification(notification, (msg) => {
                    emit.single(msg);
                  }),
                ),
                (disposable) => Effect.sync(() => disposable.dispose()),
              ),
          );
        },
      };
    }),
  },
) {}

export const findLspExecutable = Effect.fnUntraced(function* (
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

export function getUvVersion(uvBinary: string): Option.Option<string> {
  try {
    const version = NodeChildProcess.execSync(`${uvBinary} --version`, {
      encoding: "utf8",
    });
    return Option.some(version.trim());
  } catch {
    return Option.none();
  }
}

function maybeHandleLanguageClientStartError(error: LanguageClientStartError) {
  return Effect.gen(function* () {
    const code = yield* VsCode;
    const channel = yield* OutputChannel;

    yield* Effect.logError("Failed to start marimo-lsp", error);

    const uvBinary = error.exec.command;
    const uvVersion = getUvVersion(uvBinary);
    const isUvInstalled = Option.isSome(uvVersion);
    const isUsingDefaultUv = uvBinary === "uv";

    // Check if this is a uv-related error (either default "uv" or a custom path)
    if (!isUvInstalled) {
      const currentPath = NodeProcess.env.PATH ?? "(not set)";
      yield* Effect.logError(
        `uv is not available. Command: '${uvBinary}'. PATH: ${currentPath}`,
      );

      // Different error messages based on whether using default or custom uv path
      const errorMessage = isUsingDefaultUv
        ? "The marimo VS Code extension requires `uv` to be installed in your system PATH."
        : `The configured uv binary was not found at: ${uvBinary}`;

      const result = yield* code.window.showErrorMessage(errorMessage, {
        modal: true,
        items: isUsingDefaultUv
          ? ["Install uv", "Try Again"]
          : ["Open Settings", "Try Again"],
      });

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
        case "Open Settings": {
          yield* code.commands.executeCommand(
            "workbench.action.openSettings",
            "marimo.uv.path",
          );
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
