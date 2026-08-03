import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import { Cause, Data, Effect, Option, PubSub, Redacted, Stream } from "effect";
import * as lsp from "vscode-languageclient/node";

import { Config } from "../config/Config.ts";
import { NOTEBOOK_TYPE } from "../constants.ts";
import { acquireDisposable } from "../lib/acquireDisposable.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { tokenFromSignal } from "../lib/tokenFromSignal.ts";
import { VsCode } from "../platform/VsCode.ts";
import { Uv } from "../python/Uv.ts";
import * as Api from "../schemas/Models.gen.ts";
import type {
  MarimoApiCall,
  MarimoOperation,
  MarimoSessionsChanged,
} from "../types.ts";

const MAX_STDERR_LINES = 200;

export interface LspProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export class MarimoClientStartError extends Data.TaggedError(
  "MarimoClientStartError",
)<{
  exec: lsp.Executable;
  cause: unknown;
  /** Tail of the marimo-lsp stderr captured up to the failure, if any. */
  stderr?: string;
  /** Exit code/signal if marimo-lsp exited before or during startup. */
  exit?: LspProcessExit;
}> {}

export class MarimoCommandError extends Data.TaggedError("MarimoCommandError")<{
  readonly command: Redacted.Redacted<{
    readonly command: "marimo.api";
    readonly params: MarimoApiCall;
  }>;
  readonly cause: unknown;
}> {}

/**
 * The small transport seam used to construct MarimoClient.
 *
 * Production uses vscode-languageclient. Tests can provide an in-memory
 * transport without reproducing MarimoClient's named methods.
 */
interface MarimoTransport<Error = never> {
  readonly execute: (request: MarimoApiCall) => Effect.Effect<unknown, Error>;
  readonly operations: () => Stream.Stream<MarimoOperation>;
  readonly sessionChanges?: () => Stream.Stream<MarimoSessionsChanged>;
}

export function makeMarimoCommands<Error>(transport: MarimoTransport<Error>) {
  return {
    operations: transport.operations,
    sessionChanges: transport.sessionChanges ?? (() => Stream.never),
    ...Api.makeApiClient(transport.execute),
  };
}

export const makeMarimoOperationStream = Effect.fn(function* (
  register: (handler: (message: MarimoOperation) => void) => {
    readonly dispose: () => void;
  },
) {
  const operationPubSub = yield* PubSub.unbounded<MarimoOperation>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(operationPubSub));

  // vscode-languageclient stores one notification handler per method, so
  // register once and fan out to every operations() consumer.
  yield* acquireDisposable(() =>
    register((message) => {
      Effect.runSync(PubSub.publish(operationPubSub, message));
    }),
  );

  return () => Stream.fromPubSub(operationPubSub);
});

/**
 * Communication with marimo-lsp.
 *
 * This module owns the marimo-lsp process, LSP transport, named commands,
 * and operation stream.
 */
export class MarimoClient extends Effect.Service<MarimoClient>()(
  "MarimoClient",
  {
    dependencies: [Config.Default, Uv.Default],
    scoped: Effect.gen(function* () {
      const uv = yield* Uv;
      const code = yield* VsCode;
      const config = yield* Config;

      const exec = yield* Option.match(yield* config.lsp.executable, {
        onSome: Effect.succeed,
        onNone: () => findMarimoLspExecutable(uv.bin.executable),
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

      // vscode-languageclient may start a replacement process before its
      // start promise rejects. Keep both references so startup errors report
      // stderr from the process that actually exited.
      let currentSpawn: SpawnState | undefined;
      let lastExitedSpawn: SpawnState | undefined;

      const serverOptions: lsp.ServerOptions = () =>
        new Promise<NodeChildProcess.ChildProcess>((resolve, reject) => {
          const spawn: SpawnState = { stderrTail: [], pending: "" };
          currentSpawn = spawn;

          const child = NodeChildProcess.spawn(exec.command, exec.args ?? []);
          child.once("error", reject);
          if (child.pid === undefined) return;

          child.stderr?.setEncoding("utf8");
          child.stderr?.on("data", (chunk: string) => {
            spawn.pending += chunk;
            let newline: number;
            while ((newline = spawn.pending.indexOf("\n")) !== -1) {
              let line = spawn.pending.slice(0, newline);
              spawn.pending = spawn.pending.slice(newline + 1);
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

      const stopClient = Effect.fn(function* () {
        yield* Effect.tryPromise(() => client.stop()).pipe(
          Effect.timeout("5 seconds"),
          Effect.ignore,
        );
        yield* Effect.logDebug("marimo-lsp client stopped");
      });

      const startClient = () =>
        Effect.gen(function* () {
          if (!client.isRunning() && client.needsStop()) {
            yield* Effect.logDebug(
              "Client is still stopping, waiting before start",
            );
            yield* stopClient();
          }
          yield* Effect.tryPromise({
            try: () => client.start(),
            catch: (cause) => {
              const source =
                currentSpawn?.exit !== undefined
                  ? currentSpawn
                  : (lastExitedSpawn ?? currentSpawn);
              return new MarimoClientStartError({
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

      yield* Effect.addFinalizer(() => Effect.promise(() => client.dispose()));

      const operations = yield* makeMarimoOperationStream((handler) =>
        client.onNotification("marimo/operation", (message) => {
          handler(message);
        }),
      );

      const restart = () =>
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
                "MarimoClientStartError",
                Effect.fn(function* (error) {
                  const message = "Failed to restart marimo-lsp.";
                  yield* Effect.logError(message).pipe(
                    Effect.annotateLogs({ cause: Cause.fail(error) }),
                  );
                  yield* showErrorAndPromptLogs(message, {
                    channel: outputChannel,
                  });
                }),
              ),
            );
            progress.report({ message: "Done." });
          }),
        );

      const transport: MarimoTransport<
        MarimoClientStartError | MarimoCommandError
      > = {
        execute: Effect.fn(function* (request) {
          if (!client.isRunning()) {
            yield* startClient();
          }
          const command = {
            command: "marimo.api",
            params: request,
          } as const;
          return yield* Effect.tryPromise({
            try: (signal) =>
              client.sendRequest<unknown>(
                "workspace/executeCommand",
                { command: command.command, arguments: [command.params] },
                tokenFromSignal(signal),
              ),
            catch: (cause) =>
              new MarimoCommandError({
                command: Redacted.make(command),
                cause,
              }),
          }).pipe(
            Effect.withSpan("lsp.executeCommand", {
              attributes: {
                command: command.command,
                method: request.method,
              },
            }),
          );
        }),
        operations,
        sessionChanges: () =>
          Stream.asyncPush<MarimoSessionsChanged>((emit) =>
            acquireDisposable(() =>
              client.onNotification("marimo/sessionsChanged", (message) => {
                emit.single(message);
              }),
            ),
          ),
      };

      return {
        channel: {
          name: outputChannel.name,
          show: outputChannel.show.bind(outputChannel),
        },
        restart,
        ...makeMarimoCommands(transport),
      };
    }),
  },
) {}

export const findMarimoLspExecutable = Effect.fn("findMarimoLspExecutable")(
  function* (uvBinary: string, searchDirectory = __dirname) {
    const sdistDir = NodeFs.readdirSync(searchDirectory).find((file) =>
      file.startsWith("marimo_lsp-"),
    );

    if (sdistDir) {
      const sdist = NodePath.join(searchDirectory, sdistDir);
      yield* Effect.logDebug("Using bundled marimo-lsp").pipe(
        Effect.annotateLogs({ sdist }),
      );
      return {
        command: uvBinary,
        args: [
          "tool",
          "run",
          "--python",
          ">=3.13,<3.15",
          "--from",
          sdist,
          "marimo-lsp",
        ],
      };
    }

    yield* Effect.logWarning("No bundled wheel found, using development mode");

    return {
      command: uvBinary,
      args: ["run", "--directory", searchDirectory, "marimo-lsp"],
    };
  },
);
