import * as NodeChildProcess from "node:child_process";
import { Effect, Layer, Stream } from "effect";
import * as rpc from "vscode-jsonrpc/node";
import {
  ExecuteCommandError,
  findLspExecutable,
  LanguageClient,
  LanguageClientStartError,
} from "../services/LanguageClient.ts";

export const TestLanguageClientLive = Layer.scoped(
  LanguageClient,
  Effect.gen(function* () {
    const { command, args } = yield* findLspExecutable();
    const proc = NodeChildProcess.spawn(command, args, {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const connection = rpc.createMessageConnection(
      new rpc.StreamMessageReader(proc.stdout),
      new rpc.StreamMessageWriter(proc.stdin),
    );
    return LanguageClient.make({
      manage: () =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            connection.listen();
            yield* Effect.tryPromise({
              try: () =>
                connection.sendRequest("initialize", {
                  processId: process.pid,
                  capabilities: {},
                }),
              catch: (cause) =>
                new LanguageClientStartError({
                  exec: { command, args },
                  cause,
                }),
            });
            yield* Effect.promise(() =>
              connection.sendNotification("initialized", {}),
            );
          }),
          () =>
            Effect.sync(() => {
              connection.dispose();
              proc.kill();
            }),
        ),
      executeCommand(cmd) {
        return Effect.tryPromise({
          try: () =>
            connection.sendRequest("workspace/executeCommand", {
              command: cmd.command,
              arguments: [cmd.params],
            }),
          catch: (cause) => new ExecuteCommandError({ command: cmd, cause }),
        });
      },
      streamOf(notification) {
        return Stream.asyncPush((emit) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              connection.onNotification(notification, (msg) =>
                emit.single(msg),
              ),
            ),
            (disposable) => Effect.sync(() => disposable.dispose()),
          ),
        );
      },
    });
  }),
);
