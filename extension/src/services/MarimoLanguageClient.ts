import * as fs from "node:fs";
import * as path from "node:path";
import {
  Data,
  Effect,
  type ParseResult,
  Schema,
  type Scope,
  Stream,
} from "effect";
import * as vscode from "vscode";
import * as lsp from "vscode-languageclient/node";
import { MarimoNotebook } from "../schemas.ts";
import type {
  MarimoCommand,
  MarimoNotification,
  MarimoNotificationOf,
} from "../types.ts";
import { MarimoConfig } from "./MarimoConfig.ts";

export class LanguageClientStartError extends Data.TaggedError(
  "LanguageClientStartError",
)<{
  cause: unknown;
}> {}

export class ExecuteCommandError extends Data.TaggedError(
  "ExecuteCommandError",
)<{
  readonly command: MarimoCommand;
  readonly cause: unknown;
}> {}

export class MarimoLanguageClient extends Effect.Service<MarimoLanguageClient>()(
  "MarimoLanguageClient",
  {
    effect: Effect.gen(function* () {
      const exec = yield* getLspExecutable();
      yield* Effect.logInfo("Starting language server").pipe(
        Effect.annotateLogs({
          component: "language-client",
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
          outputChannel: vscode.window.createOutputChannel("marimo-lsp", {
            log: true,
          }),
          revealOutputChannelOn: lsp.RevealOutputChannelOn.Never,
        },
      );
      return {
        manage() {
          return Effect.acquireRelease(
            Effect.tryPromise({
              try: () => client.start(),
              catch: (cause) => new LanguageClientStartError({ cause }),
            }),
            () => Effect.sync(() => client.dispose()),
          );
        },
        streamOf<Notification extends MarimoNotification>(
          notification: Notification,
        ): Stream.Stream<
          MarimoNotificationOf<Notification>,
          never,
          Scope.Scope
        > {
          return Stream.async((emit) =>
            Effect.acquireRelease(
              Effect.sync(() =>
                client.onNotification(notification, emit.single.bind(emit)),
              ),
              (disposable) => Effect.sync(() => disposable.dispose()),
            ),
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
                kind: vscode.NotebookCellKind.Code,
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
    }),
  },
) {}

type ParamsFor<Command extends MarimoCommand["command"]> = Extract<
  MarimoCommand,
  { command: Command }
>["params"];

function getLspExecutable(): Effect.Effect<
  lsp.Executable,
  never,
  MarimoConfig
> {
  return Effect.gen(function* () {
    const config = yield* MarimoConfig;

    if (config.lsp.executable) {
      const { command, args } = config.lsp.executable;
      return {
        command,
        args,
        transport: lsp.TransportKind.stdio,
      };
    }

    // Look for bundled wheel matching marimo_lsp-* pattern
    const sdistDir = fs
      .readdirSync(__dirname)
      .find((f) => f.startsWith("marimo_lsp-"));

    if (sdistDir) {
      const sdist = path.join(__dirname, sdistDir);
      yield* Effect.logInfo("Using bundled marimo-lsp").pipe(
        Effect.annotateLogs({ sdist }),
      );
      return {
        command: "uvx",
        args: ["--from", sdist, "marimo-lsp"],
        transport: lsp.TransportKind.stdio,
      };
    }

    // Fallback to development mode if no wheel found
    yield* Effect.logWarning(
      "No bundled wheel found, using development mode",
    ).pipe(Effect.annotateLogs({ directory: __dirname }));

    return {
      command: "uv",
      args: ["run", "--directory", __dirname, "marimo-lsp"],
      transport: lsp.TransportKind.stdio,
    };
  });
}

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
