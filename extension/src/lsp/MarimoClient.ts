import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import {
  Cause,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  PubSub,
  Queue,
  Redacted,
  Schema,
  Stream,
} from "effect";
import * as lsp from "vscode-languageclient/node";

import { Config, MarimoLspServer } from "../config/Config.ts";
import { NOTEBOOK_TYPE } from "../constants.ts";
import { acquireDisposable } from "../lib/acquireDisposable.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { tokenFromSignal } from "../lib/tokenFromSignal.ts";
import { VsCode } from "../platform/VsCode.ts";
import { Uv } from "../python/Uv.ts";
import * as Api from "../schemas/Models.gen.ts";
import { Telemetry } from "../telemetry/Telemetry.ts";
import type {
  DocumentAnalysis,
  KernelNotification,
  MarimoApiCall,
  MarimoSessionsChanged,
} from "../types.ts";

const MAX_STDERR_LINES = 200;
const CUSTOM_LSP_FAILURE_MESSAGE =
  "The configured marimo-lsp command failed. Custom language servers are for extension development and may be incompatible with this extension build. Update marimo.lsp.path or switch to a bundled language server.";
const decodeKernelNotification = Schema.decodeUnknownOption(
  Api.KernelNotification,
);
const decodeDocumentAnalysis = Schema.decodeUnknownOption(Api.DocumentAnalysis);

export type MarimoLspMode = "wasm" | "uv" | "configured";

const MarimoLspExecutable = Data.taggedEnum<MarimoLspExecutable>();
type MarimoLspExecutable = Data.TaggedEnum<{
  Configured: { readonly exec: lsp.Executable };
  Wasm: { readonly exec: lsp.Executable };
  Uv: { readonly exec: lsp.Executable };
}>;

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
  mode: MarimoLspMode;
}> {}

export class MarimoCommandError extends Data.TaggedError("MarimoCommandError")<{
  readonly command: Redacted.Redacted<{
    readonly command: "marimo.api";
    readonly params: MarimoApiCall;
  }>;
  readonly cause: unknown;
  readonly mode: MarimoLspMode;
}> {}

/**
 * The small transport seam used to construct MarimoClient.
 *
 * Production uses vscode-languageclient. Tests can provide an in-memory
 * transport without reproducing MarimoClient's named methods.
 */
interface MarimoTransport<Error = never> {
  readonly execute: (request: MarimoApiCall) => Effect.Effect<unknown, Error>;
  readonly kernelNotifications: Stream.Stream<KernelNotification>;
  readonly documentAnalysis?: Stream.Stream<DocumentAnalysis>;
  readonly sessionChanges?: Stream.Stream<MarimoSessionsChanged>;
}

export function makeMarimoCommands<Error>(transport: MarimoTransport<Error>) {
  return {
    kernelNotifications: transport.kernelNotifications,
    documentAnalysis: transport.documentAnalysis ?? Stream.never,
    sessionChanges: transport.sessionChanges ?? Stream.never,
    ...Api.makeApiClient(transport.execute),
  };
}

export const makeKernelNotificationStream = Effect.fn(function* (
  register: (handler: (message: unknown) => void) => {
    readonly dispose: () => void;
  },
) {
  const notifications = yield* PubSub.unbounded<KernelNotification>();
  const runSync = Effect.runSyncWith(yield* Effect.context());
  yield* Effect.addFinalizer(() => PubSub.shutdown(notifications));

  // vscode-languageclient stores one notification handler per method, so
  // register once and fan out to every consumer.
  yield* acquireDisposable(() =>
    register((message) => {
      const decoded = decodeKernelNotification(message);
      if (Option.isNone(decoded)) {
        runSync(Effect.logWarning("Ignored invalid kernel notification"));
        return;
      }
      runSync(PubSub.publish(notifications, decoded.value));
    }),
  );

  return Stream.fromPubSub(notifications);
});

export const makeDocumentAnalysisStream = Effect.fn(function* (
  register: (handler: (message: unknown) => void) => {
    readonly dispose: () => void;
  },
) {
  const analyses = yield* PubSub.unbounded<DocumentAnalysis>();
  const runSync = Effect.runSyncWith(yield* Effect.context());
  yield* Effect.addFinalizer(() => PubSub.shutdown(analyses));

  yield* acquireDisposable(() =>
    register((message) => {
      const decoded = decodeDocumentAnalysis(message);
      if (Option.isNone(decoded)) {
        runSync(Effect.logWarning("Ignored invalid document analysis"));
        return;
      }
      runSync(PubSub.publish(analyses, decoded.value));
    }),
  );

  return Stream.fromPubSub(analyses);
});

/**
 * Communication with marimo-lsp.
 *
 * This module owns the marimo-lsp process, LSP transport, named commands,
 * and operation stream.
 */
export class MarimoClient extends Context.Service<MarimoClient>()(
  "MarimoClient",
  {
    make: Effect.gen(function* () {
      const code = yield* VsCode;
      const config = yield* Config;
      const telemetry = yield* Telemetry;

      const lspServer = yield* config.lsp.server.pipe(
        Effect.catchTag(
          "InvalidMarimoLspConfiguration",
          Effect.fn(function* (error) {
            yield* Effect.logError("Invalid marimo-lsp configuration").pipe(
              Effect.annotateLogs({
                cause: Cause.fail(error),
                setting: error.setting,
              }),
            );
            yield* code.window.showErrorMessage(
              `${error.message} Falling back to the WASM language server.`,
            );
            return MarimoLspServer.Wasm();
          }),
        ),
      );
      const uv = yield* Uv;
      const selection = yield* selectMarimoLspExecutable({
        server: lspServer,
        resolveUvBinary: Effect.map(uv.bin, ({ executable }) => executable),
      });
      const { exec } = selection;
      const mode = marimoLspMode(selection);
      yield* telemetry.lspModeSelected(mode);

      yield* Effect.logInfo("Starting marimo-lsp").pipe(
        Effect.annotateLogs(
          MarimoLspExecutable.$match(selection, {
            Configured: ({ exec }) => ({
              mode: "configured",
              command: exec.command,
              args: (exec.args ?? []).join(" "),
            }),
            Wasm: () => ({ mode: "wasm" }),
            Uv: () => ({ mode: "uv" }),
          }),
        ),
      );

      const outputChannel =
        yield* code.window.createLogOutputChannel("marimo-lsp");
      const notifyCustomLspFailure = yield* makeCustomLspFailureNotifier({
        mode,
        channel: outputChannel,
      });

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

          const child = NodeChildProcess.spawn(
            exec.command,
            exec.args ?? [],
            exec.options,
          );
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
        // LanguageClient.needsStop() also returns true while Starting, but
        // stop() rejects unless the client has an active Running connection.
        if (!client.isRunning()) return;
        yield* Effect.tryPromise(() => client.stop()).pipe(
          Effect.timeout("5 seconds"),
          Effect.ignore,
        );
        yield* Effect.logDebug("marimo-lsp client stopped");
      });

      const startClient = () =>
        Effect.gen(function* () {
          // start() is single-flight while the client is Starting, so there is
          // no need to stop an in-progress start before awaiting it.
          yield* Effect.tryPromise({
            try: () => client.start(),
            catch: (cause) => {
              const source =
                currentSpawn?.exit !== undefined
                  ? currentSpawn
                  : (lastExitedSpawn ?? currentSpawn);
              return new MarimoClientStartError({
                exec,
                mode,
                cause,
                stderr:
                  source && source.stderrTail.length > 0
                    ? source.stderrTail.join("\n")
                    : undefined,
                exit: source?.exit,
              });
            },
          });
          yield* telemetry.lspStarted(mode);
          yield* Effect.logInfo("marimo-lsp client started").pipe(
            Effect.annotateLogs({ "lsp.mode": mode }),
          );
        }).pipe(Effect.withSpan("lsp.start"));

      yield* Effect.addFinalizer(() => disposeLanguageClient(client));

      const kernelNotifications = yield* makeKernelNotificationStream(
        (handler) =>
          client.onNotification("marimo/kernelNotification", (message) => {
            handler(message);
          }),
      );
      const documentAnalysis = yield* makeDocumentAnalysisStream((handler) =>
        client.onNotification("marimo/documentAnalysis", (message) => {
          handler(message);
        }),
      );

      const restart = code.window.withProgress(
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
            Effect.tap(() =>
              Effect.sync(() => progress.report({ message: "Done." })),
            ),
            Effect.catchTag(
              "MarimoClientStartError",
              Effect.fn(function* (error) {
                const message = "Failed to restart marimo-lsp.";
                yield* Effect.logError(message).pipe(
                  Effect.annotateLogs({
                    cause: Cause.fail(error),
                    "lsp.mode": mode,
                  }),
                );
                yield* showErrorAndPromptLogs(message, {
                  channel: outputChannel,
                });
              }),
            ),
          );
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
                mode,
              }),
          }).pipe(
            Effect.tapError(() => Effect.forkDetach(notifyCustomLspFailure)),
            Effect.withSpan("lsp.executeCommand", {
              attributes: {
                command: command.command,
                method: request.method,
              },
            }),
          );
        }),
        kernelNotifications,
        documentAnalysis,
        sessionChanges: Stream.callback<MarimoSessionsChanged>((queue) =>
          acquireDisposable(() =>
            client.onNotification("marimo/sessionsChanged", (message) => {
              Queue.offerUnsafe(queue, message);
            }),
          ),
        ),
      };

      return {
        server: lspServer,
        channel: {
          name: outputChannel.name,
          show: outputChannel.show.bind(outputChannel),
        },
        restart,
        ...makeMarimoCommands(transport),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([Config.layer, Uv.layer]),
  );
}

export const makeCustomLspFailureNotifier = Effect.fn(
  "MarimoClient.makeCustomLspFailureNotifier",
)(function* ({
  mode,
  channel,
}: {
  readonly mode: MarimoLspMode;
  readonly channel: { readonly name: string; show(): void };
}) {
  const code = yield* VsCode;
  return yield* Effect.cached(
    Effect.gen(function* () {
      if (mode !== "configured") return;
      const selection = yield* code.window.showErrorMessage(
        CUSTOM_LSP_FAILURE_MESSAGE,
        { items: ["Open Logs", "Open Settings"] },
      );
      if (Option.isNone(selection)) return;

      if (selection.value === "Open Logs") {
        channel.show();
        return;
      }
      yield* code.commands.executeVSCode(
        "workbench.action.openSettings",
        "marimo.lsp",
      );
    }),
  );
});

function marimoLspMode(selection: MarimoLspExecutable): MarimoLspMode {
  return MarimoLspExecutable.$match(selection, {
    Configured: () => "configured" as const,
    Wasm: () => "wasm" as const,
    Uv: () => "uv" as const,
  });
}

/**
 * Dispose the language client without allowing dependency cleanup failures to
 * fail the owning Effect scope. NodeLanguageClient still runs its process-kill
 * cleanup in a `finally`, even when graceful protocol shutdown rejects.
 */
export function disposeLanguageClient(
  client: Pick<lsp.LanguageClient, "dispose">,
): Effect.Effect<void> {
  return Effect.tryPromise(() => client.dispose()).pipe(
    Effect.timeout("5 seconds"),
    Effect.ignore,
  );
}

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

export const selectMarimoLspExecutable = Effect.fn("selectMarimoLspExecutable")(
  function* ({
    server,
    resolveUvBinary,
    searchDirectory = __dirname,
  }: {
    readonly server: MarimoLspServer;
    readonly resolveUvBinary: Effect.Effect<string>;
    readonly searchDirectory?: string;
  }) {
    return yield* MarimoLspServer.$match(server, {
      Custom: ({ command: [executable, ...args] }) =>
        Effect.succeed(
          MarimoLspExecutable.Configured({
            exec: { command: executable, args },
          }),
        ),
      Wasm: () =>
        Effect.succeed(
          MarimoLspExecutable.Wasm({
            exec: findWasmMarimoLspExecutable(searchDirectory),
          }),
        ),
      Python: () =>
        Effect.flatMap(resolveUvBinary, (uvBinary) =>
          Effect.map(
            findMarimoLspExecutable(uvBinary, searchDirectory),
            (exec) => MarimoLspExecutable.Uv({ exec }),
          ),
        ),
    });
  },
);

export function findWasmMarimoLspExecutable(
  searchDirectory = __dirname,
): lsp.Executable {
  return {
    command: NodeProcess.execPath,
    args: [NodePath.join(searchDirectory, "wasmServer.js")],
    options: {
      env: {
        ...NodeProcess.env,
        // VS Code runs extensions in Electron. This makes the dedicated
        // language-server child use Electron's bundled Node runtime.
        ELECTRON_RUN_AS_NODE: "1",
      },
    },
  };
}
