import * as NodeChildProcess from "node:child_process";

import { type Context, Effect, Layer, Queue, Redacted, Stream } from "effect";
import * as rpc from "vscode-jsonrpc/node";

import { MarimoLspServer } from "../config/Config.ts";
import { acquireDisposable } from "../lib/acquireDisposable.ts";
import {
  findMarimoLspExecutable,
  makeMarimoCommands,
  MarimoClient,
  MarimoCommandError,
} from "../lsp/MarimoClient.ts";

/**
 * Process-backed Adapter for tests that intentionally verify the
 * TypeScript/Python marimo command contract.
 *
 * Unit tests should use `makeTestMarimoClient` instead. Constructing this
 * Layer starts a real `marimo-lsp` process and performs an LSP handshake.
 */
export const TestMarimoClientProcess = Layer.effect(
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
    const service: Context.Service.Shape<typeof MarimoClient> = {
      server: MarimoLspServer.Python(),
      channel: {
        name: "marimo-lsp",
        show() {},
      },
      restart: Effect.void,
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
            catch: (cause) =>
              new MarimoCommandError({
                command: Redacted.make(command),
                cause,
                mode: "uv",
              }),
          });
        },
        operations: Stream.callback((queue) =>
          acquireDisposable(() =>
            conn.onNotification("marimo/operation", (message) => {
              Queue.offerUnsafe(queue, message);
            }),
          ),
        ),
        sessionChanges: Stream.callback((queue) =>
          acquireDisposable(() =>
            conn.onNotification("marimo/sessionsChanged", (message) => {
              Queue.offerUnsafe(queue, message);
            }),
          ),
        ),
      }),
    };
    return service;
  }),
);
