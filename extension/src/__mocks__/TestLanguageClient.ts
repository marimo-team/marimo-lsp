import * as NodeChildProcess from "node:child_process";
import { Effect, Layer, Stream } from "effect";
import * as rpc from "vscode-jsonrpc/node";
import {
  ExecuteCommandError,
  findLspExecutable,
  LanguageClient,
} from "../services/LanguageClient.ts";

export const TestLanguageClientLive = Layer.scoped(
  LanguageClient,
  Effect.gen(function*() {
    const { conn } = yield* Effect.acquireRelease(
      Effect.gen(function*() {
        const exec = yield* findLspExecutable("uv");
        const proc = NodeChildProcess.spawn(exec.command, exec.args, {
          stdio: ["pipe", "pipe", "inherit"],
        });
        const conn = rpc.createMessageConnection(
          new rpc.StreamMessageReader(proc.stdout),
          new rpc.StreamMessageWriter(proc.stdin),
        );
        conn.listen();
        yield* Effect.promise(() =>
          conn.sendRequest("initialize", {
            processId: process.pid,
            capabilities: {},
          }),
        );
        yield* Effect.promise(() => conn.sendNotification("initialized", {}));
        return { conn, proc };
      }),
      ({ conn, proc }) =>
        Effect.sync(() => {
          conn.dispose();
          proc.kill();
        }),
    );
    return LanguageClient.make({
      channel: {
        name: "marimo-lsp",
        show() { },
      },
      restart: () => Effect.void,
      executeCommand(cmd) {
        return Effect.tryPromise({
          try: () =>
            conn.sendRequest("workspace/executeCommand", {
              command: cmd.command,
              arguments: [cmd.params],
            }),
          catch: (cause) => new ExecuteCommandError({ command: cmd, cause }),
        });
      },
      streamOf(notification) {
        return Stream.asyncPush((emit) =>
          Effect.acquireRelease(
            Effect.sync(() => conn.onNotification(notification, (msg) => emit.single(msg))),
            (disposable) => Effect.sync(() => disposable.dispose()),
          ),
        );
      },
    });
  }),
);
