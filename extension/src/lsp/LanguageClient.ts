import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import { Cause, Data, Effect, Option, Stream } from "effect";
import * as lsp from "vscode-languageclient/node";

import { Config } from "../config/Config.ts";
import { NOTEBOOK_TYPE } from "../constants.ts";
import { acquireDisposable } from "../lib/acquireDisposable.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { tokenFromSignal } from "../lib/tokenFromSignal.ts";
import { VsCode } from "../platform/VsCode.ts";
import { Uv } from "../python/Uv.ts";
import type {
  MarimoCommand,
  MarimoLspNotification,
  MarimoLspNotificationOf,
} from "../types.ts";

/** Maximum number of stderr lines retained from the LSP subprocess. */
const MAX_STDERR_LINES = 200;

export interface LspProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export class LanguageClientStartError extends Data.TaggedError(
  "LanguageClientStartError",
)<{
  exec: lsp.Executable;
  cause: unknown;
  /** Tail of the LSP subprocess stderr captured up to the failure, if any. */
  stderr?: string;
  /** Exit code/signal of the LSP subprocess if it exited before/during start. */
  exit?: LspProcessExit;
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

      yield* Effect.logDebug("Got marimo-lsp executable").pipe(
        Effect.annotateLogs({
          command: exec.command,
          args: (exec.args ?? []).join(" "),
        }),
      );

      const outputChannel =
        yield* code.window.createLogOutputChannel("marimo-lsp");

      interface SpawnState {
        readonly stderrTail: string[];
        pending: string;
        exit?: LspProcessExit;
      }
      // `currentSpawn` is the most recent serverOptions() invocation;
      // `lastExitedSpawn` is the most recent spawn whose child has exited.
      // vscode-languageclient auto-restarts on crash, so when start() finally
      // rejects, currentSpawn often points to a fresh child that hasn't yet
      // produced output — the failure data lives on the previous (exited)
      // spawn.
      let currentSpawn: SpawnState | undefined;
      let lastExitedSpawn: SpawnState | undefined;

      const serverOptions: lsp.ServerOptions = () =>
        new Promise<NodeChildProcess.ChildProcess>((resolve, reject) => {
          const spawn: SpawnState = { stderrTail: [], pending: "" };
          currentSpawn = spawn;

          const child = NodeChildProcess.spawn(exec.command, exec.args ?? []);
          // Always reject on spawn failure — `pid === undefined` is a
          // sync-detected failure path, but other failures surface
          // asynchronously via the "error" event.
          child.once("error", reject);
          if (child.pid === undefined) return;

          child.stderr?.setEncoding("utf8");
          child.stderr?.on("data", (chunk: string) => {
            spawn.pending += chunk;
            let nl: number;
            while ((nl = spawn.pending.indexOf("\n")) !== -1) {
              let line = spawn.pending.slice(0, nl);
              spawn.pending = spawn.pending.slice(nl + 1);
              if (line.endsWith("\r")) line = line.slice(0, -1);
              if (line.length === 0) continue;
              spawn.stderrTail.push(line);
              if (spawn.stderrTail.length > MAX_STDERR_LINES) {
                spawn.stderrTail.shift();
              }
            }
          });
          child.once("exit", (code, signal) => {
            if (spawn.pending.length > 0) {
              spawn.stderrTail.push(spawn.pending);
              spawn.pending = "";
            }
            spawn.exit = { code, signal };
            lastExitedSpawn = spawn;
          });
          resolve(child);
        });

      const client = new lsp.LanguageClient(
        "marimo-lsp",
        "Marimo Language Server",
        serverOptions,
        {
          // create a dedicated output channel for marimo-lsp messages
          outputChannel,
          revealOutputChannelOn: lsp.RevealOutputChannelOn.Never,
          documentSelector: [
            { notebook: NOTEBOOK_TYPE, language: "sql" },
            { notebook: NOTEBOOK_TYPE, language: "python" },
            { notebook: NOTEBOOK_TYPE, language: "mo-python" },
            { notebook: NOTEBOOK_TYPE, language: "markdown" },
          ],
        },
      );

      /**
       * Stop the client, with a timeout to avoid hanging indefinitely.
       *
       * Some LSP lifecycle errors occur because `client.stop()` never
       * resolves (e.g. the server process is stuck). A bounded stop
       * prevents the restart flow from blocking forever.
       */
      const stopClient = Effect.fn(function* () {
        yield* Effect.tryPromise(() => client.stop()).pipe(
          Effect.timeout("5 seconds"),
          Effect.ignore,
        );
        yield* Effect.logDebug("marimo-lsp client stopped");
      });

      /**
       * Start the client. Waits until the client is fully stopped first,
       * avoiding the "Client is currently stopping" race.
       */
      const startClient = () =>
        Effect.gen(function* () {
          // If the client is in a "stopping" state, wait for it to finish
          // before attempting to start again.
          if (!client.isRunning() && client.needsStop()) {
            yield* Effect.logDebug(
              "Client is still stopping, waiting before start",
            );
            yield* stopClient();
          }
          yield* Effect.tryPromise({
            try: () => client.start(),
            catch: (cause) => {
              // Prefer the spawn whose exit we actually observed — current
              // may have been replaced by an auto-restart whose child hasn't
              // produced output yet.
              const source =
                currentSpawn?.exit !== undefined
                  ? currentSpawn
                  : (lastExitedSpawn ?? currentSpawn);
              return new LanguageClientStartError({
                exec,
                cause,
                stderr:
                  source && source.stderrTail.length > 0
                    ? source.stderrTail.join("\n")
                    : undefined,
                exit: source?.exit,
              });
            },
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
    yield* Effect.logDebug("Using bundled marimo-lsp").pipe(
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
