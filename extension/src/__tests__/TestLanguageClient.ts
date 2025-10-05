import * as NodeChildProcess from "node:child_process";
import { Effect, Layer, Option, Ref, Stream } from "effect";
import * as rpc from "vscode-jsonrpc/node";
import {
  ExecuteCommandError,
  findLspExecutable,
  LanguageClient,
  LanguageClientStartError,
} from "../services/LanguageClient.ts";

export const TestLanguageClientLive = Layer.effect(
  LanguageClient,
  Effect.gen(function* () {
    const ref = yield* Ref.make<Option.Option<rpc.MessageConnection>>(
      Option.none(),
    );
    return LanguageClient.make({
      manage: () =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            const exec = yield* findLspExecutable();
            const proc = NodeChildProcess.spawn(exec.command, exec.args, {
              stdio: ["pipe", "pipe", "inherit"],
            });
            const conn = rpc.createMessageConnection(
              new rpc.StreamMessageReader(proc.stdout),
              new rpc.StreamMessageWriter(proc.stdin),
            );
            conn.listen();
            yield* Effect.tryPromise({
              try: () =>
                conn.sendRequest("initialize", {
                  processId: process.pid,
                  capabilities: {},
                }),
              catch: (cause) =>
                new LanguageClientStartError({
                  exec,
                  cause,
                }),
            });
            yield* Effect.promise(() =>
              conn.sendNotification("initialized", {}),
            );
            yield* Ref.set(ref, Option.some(conn));
            return { conn, proc };
          }),
          ({ conn, proc }) =>
            Effect.gen(function* () {
              conn.dispose();
              proc.kill();
              yield* Ref.set(ref, Option.none());
            }),
        ),
      executeCommand(cmd) {
        return Effect.gen(function* () {
          const conn = Option.getOrThrowWith(
            yield* Ref.get(ref),
            () => new Error("Language server connection closed."),
          );
          return yield* Effect.tryPromise({
            try: () =>
              conn.sendRequest("workspace/executeCommand", {
                command: cmd.command,
                arguments: [cmd.params],
              }),
            catch: (cause) => new ExecuteCommandError({ command: cmd, cause }),
          });
        });
      },
      streamOf(notification) {
        return Stream.asyncPush((emit) =>
          Effect.acquireRelease(
            Effect.gen(function* () {
              const conn = Option.getOrThrowWith(
                yield* Ref.get(ref),
                () => new Error("Language server connection closed."),
              );
              return conn.onNotification(notification, (msg) =>
                emit.single(msg),
              );
            }),
            (disposable) => Effect.sync(() => disposable.dispose()),
          ),
        );
      },
    });
  }),
);
