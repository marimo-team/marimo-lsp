import * as NodeChildProcess from "node:child_process";

import { Effect, Layer, Stream } from "effect";
import * as rpc from "vscode-jsonrpc/node";

import { acquireDisposable } from "../lib/acquireDisposable.ts";
import {
  findMarimoLspExecutable,
  makeMarimoCommands,
  MarimoClient,
  MarimoCommandError,
} from "../lsp/MarimoClient.ts";

export const TestMarimoClientLive = Layer.scoped(
  MarimoClient,
  Effect.gen(function* () {
    const { conn } = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const exec = yield* findMarimoLspExecutable("uv");
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
    return MarimoClient.make({
      channel: {
        name: "marimo-lsp",
        show() {},
      },
      restart: () => Effect.void,
      ...makeMarimoCommands({
        execute(request) {
          const command = {
            command: "marimo.api",
            params: request,
          } as const;
          return Effect.tryPromise({
            try: () =>
              conn.sendRequest("workspace/executeCommand", {
                command: command.command,
                arguments: [command.params],
              }),
            catch: (cause) => new MarimoCommandError({ command, cause }),
          });
        },
        operations() {
          return Stream.asyncPush((emit) =>
            acquireDisposable(() =>
              conn.onNotification("marimo/operation", (message) => {
                emit.single(message);
              }),
            ),
          );
        },
        sessionChanges() {
          return Stream.asyncPush((emit) =>
            acquireDisposable(() =>
              conn.onNotification("marimo/sessionsChanged", (message) => {
                emit.single(message);
              }),
            ),
          );
        },
      }),
    });
  }),
);
