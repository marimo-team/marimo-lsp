import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { Data, Effect, Option, type ParseResult, Schema } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageclient/node";
import { MarimoNotebook } from "../schemas.ts";
import type {
  MarimoCommand,
  MarimoNotification,
  MarimoNotificationOf,
} from "../types.ts";
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

      const exec = yield* Option.match(config.lsp.executable, {
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
        onNotification<Notification extends MarimoNotification>(
          notification: Notification,
          cb: (msg: MarimoNotificationOf<Notification>) => void,
        ) {
          return Effect.acquireRelease(
            Effect.sync(() =>
              client.onNotification(notification, (msg) => cb(msg)),
            ),
            (disposable) => Effect.sync(() => disposable.dispose()),
          );
        },
        run(
          params: ParamsFor<"marimo.run">,
        ): Effect.Effect<void, ExecuteCommandError, never> {
          return executeCommand(client, { command: "marimo.run", params });
        },
        setUiElementValue(
          params: ParamsFor<"marimo.set_ui_element_value">,
        ): Effect.Effect<void, ExecuteCommandError, never> {
          return executeCommand(client, {
            command: "marimo.set_ui_element_value",
            params,
          });
        },
        functionCallRequest(
          params: ParamsFor<"marimo.function_call_request">,
        ): Effect.Effect<void, ExecuteCommandError, never> {
          return executeCommand(client, {
            command: "marimo.function_call_request",
            params,
          });
        },
        interrupt(
          params: ParamsFor<"marimo.interrupt">,
        ): Effect.Effect<void, ExecuteCommandError, never> {
          return executeCommand(client, {
            command: "marimo.interrupt",
            params,
          });
        },
        dap(
          params: ParamsFor<"marimo.dap">,
        ): Effect.Effect<void, ExecuteCommandError, never> {
          return executeCommand(client, { command: "marimo.dap", params });
        },
        serialize(
          params: vscode.NotebookData,
        ): Effect.Effect<
          Uint8Array,
          ExecuteCommandError | ParseResult.ParseError,
          never
        > {
          return Effect.gen(function* () {
            const notebook = yield* notebookDataToMarimoNotebook(params);
            const resp = yield* executeCommand(client, {
              command: "marimo.serialize",
              params: { notebook },
            });
            const result = yield* decodeSerializeResponse(resp);
            return new TextEncoder().encode(result.source);
          });
        },
        deserialize(
          buf: Uint8Array,
        ): Effect.Effect<
          vscode.NotebookData,
          ExecuteCommandError | ParseResult.ParseError,
          never
        > {
          return Effect.gen(function* () {
            const resp = yield* executeCommand(client, {
              command: "marimo.deserialize",
              params: { source: new TextDecoder().decode(buf) },
            });
            const { cells, ...metadata } =
              yield* decodeDeserializeResponse(resp);
            return {
              metadata: metadata,
              cells: cells.map((cell) => ({
                kind: code.NotebookCellKind.Code,
                value: cell.code,
                languageId: "python",
                metadata: {
                  name: cell.name,
                  options: cell.options,
                },
              })),
            };
          });
        },
      };
    }).pipe(Effect.annotateLogs("service", "LanguageClient")),
  },
) {}

type ParamsFor<Command extends MarimoCommand["command"]> = Extract<
  MarimoCommand,
  { command: Command }
>["params"];

const findLspExecutable = Effect.fnUntraced(function* () {
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

function executeCommand(
  client: lsp.BaseLanguageClient,
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
        cancellationTokenFor(signal),
      ),
    catch: (cause) => new ExecuteCommandError({ command: cmd, cause }),
  });
}

function cancellationTokenFor(signal: AbortSignal): vscode.CancellationToken {
  return {
    get isCancellationRequested() {
      return signal.aborted;
    },
    onCancellationRequested(listener, thisArgs, disposables) {
      const handler = () => listener.call(thisArgs, undefined);
      signal.addEventListener("abort", handler);
      const disposable = {
        dispose: () => signal.removeEventListener("abort", handler),
      };
      if (disposables) {
        disposables.push(disposable);
      }
      return disposable;
    },
  };
}

const decodeDeserializeResponse = Schema.decodeUnknown(MarimoNotebook);
const decodeSerializeResponse = Schema.decodeUnknown(
  Schema.Struct({ source: Schema.String }),
);

function notebookDataToMarimoNotebook(
  notebook: vscode.NotebookData,
): Effect.Effect<typeof MarimoNotebook.Type, ParseResult.ParseError, never> {
  const { cells, metadata = {} } = notebook;
  // Deserialize response is just the IR for our notebook
  return decodeDeserializeResponse({
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
}
