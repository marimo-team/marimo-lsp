import * as NodeNet from "node:net";

import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Array as EffectArray, Stream } from "effect";
import type * as vscode from "vscode";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { createSourceMapping, makeDapProxy } from "../dap-proxy.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encodeDap(msg: unknown): string {
  const json = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`;
}

function parseDapMessages(raw: string): unknown[] {
  const messages: unknown[] = [];
  let buf = raw;
  while (buf.length > 0) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = buf.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const len = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buf.length < bodyStart + len) break;
    messages.push(JSON.parse(buf.slice(bodyStart, bodyStart + len)));
    buf = buf.slice(bodyStart + len);
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Mock debugpy TCP server as a scoped Effect service
// ---------------------------------------------------------------------------

type Connection = {
  dispatch(msg: unknown): void;
  messages: Stream.Stream<Uint8Array, Error>;
};

const withTestCtx = Effect.fn(function* (
  mapping: ReturnType<typeof createSourceMapping>,
) {
  const port = yield* Deferred.make<number, Error>();
  const connection = yield* Deferred.make<Connection, Error>();

  const server = NodeNet.createServer((socket) =>
    Effect.runSync(
      Deferred.succeed(connection, {
        dispatch: (msg) => socket.write(encodeDap(msg)),
        messages: Stream.async<Uint8Array, Error>((emit) => {
          socket.on("data", (chunk) => emit.single(chunk));
          socket.on("end", () => emit.end());
          socket.on("error", (err) => emit.fail(err));
        }),
      }),
    ),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));

  server.listen(0, () => {
    const addr = server.address();
    if (addr == null || typeof addr === "string") {
      return;
    }
    Effect.runSync(Deferred.succeed(port, addr.port));
  });

  return {
    proxy: yield* makeDapProxy(
      "127.0.0.1",
      yield* Deferred.await(port),
      mapping,
    ).pipe(Effect.provide(TestVsCode.Default)),
    conn: yield* Deferred.await(connection),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const CELL_URI = "vscode-notebook-cell://auth/cell-abc123";
const TEMP_FILE = "/tmp/marimo_12345/__marimo__cell_abc123_.py";

/** Take the first chunk from the connection's message stream and parse DAP messages from it. */
function takeFirstMessage(conn: Connection) {
  return conn.messages.pipe(
    Stream.take(1),
    Stream.runFold("", (acc, chunk) => acc + chunk.toString()),
    Effect.map(parseDapMessages),
    Effect.flatMap(EffectArray.head),
  );
}

describe("makeDapProxy", () => {
  it.scoped(
    "rewrites source.path in setBreakpoints (cell URI -> temp file)",
    Effect.fn(function* () {
      const { conn, proxy } = yield* withTestCtx(
        createSourceMapping({ [CELL_URI]: TEMP_FILE }),
      );

      proxy.adapter.handleMessage({
        type: "request",
        seq: 1,
        command: "setBreakpoints",
        arguments: {
          source: { path: CELL_URI },
          breakpoints: [{ line: 5 }],
        },
      });

      expect(yield* takeFirstMessage(conn)).toMatchInlineSnapshot(`
          {
            "arguments": {
              "breakpoints": [
                {
                  "line": 5,
                },
              ],
              "source": {
                "path": "/tmp/marimo_12345/__marimo__cell_abc123_.py",
              },
            },
            "command": "setBreakpoints",
            "seq": 1,
            "type": "request",
          }
        `);
    }),
  );

  it.scoped(
    "signals ready and forwards configurationDone message",
    Effect.fn(function* () {
      const { proxy, conn } = yield* withTestCtx(createSourceMapping({}));

      proxy.adapter.handleMessage({
        type: "request",
        seq: 2,
        command: "configurationDone",
      });

      yield* proxy.ready;
      expect(yield* takeFirstMessage(conn)).toMatchInlineSnapshot(`
          {
            "command": "configurationDone",
            "seq": 2,
            "type": "request",
          }
        `);
    }),
  );

  it.scoped(
    "rewrites source.path in responses from debugpy (temp file -> cell URI)",
    Effect.fn(function* () {
      const { proxy, conn } = yield* withTestCtx(
        createSourceMapping({ [CELL_URI]: TEMP_FILE }),
      );

      // Subscribe to proxy's outgoing messages (debugpy -> VS Code)
      const received = yield* Deferred.make<vscode.DebugProtocolMessage>();
      proxy.adapter.onDidSendMessage((msg) => {
        Effect.runFork(Deferred.succeed(received, msg));
      });

      conn.dispatch({
        type: "event",
        seq: 10,
        event: "stopped",
        body: {
          reason: "breakpoint",
          source: { path: TEMP_FILE },
        },
      });

      expect(yield* Deferred.await(received)).toMatchInlineSnapshot(`
          {
            "body": {
              "reason": "breakpoint",
              "source": {
                "path": "vscode-notebook-cell://auth/cell-abc123",
              },
            },
            "event": "stopped",
            "seq": 10,
            "type": "event",
          }
        `);
    }),
  );

  it.scoped(
    "forwards unrecognized messages unchanged",
    Effect.fn(function* () {
      const { proxy, conn } = yield* withTestCtx(
        createSourceMapping({ [CELL_URI]: TEMP_FILE }),
      );

      proxy.adapter.handleMessage({
        type: "request",
        seq: 3,
        command: "continue",
        arguments: { threadId: 1 },
      });

      expect(yield* takeFirstMessage(conn)).toMatchInlineSnapshot(`
          {
            "arguments": {
              "threadId": 1,
            },
            "command": "continue",
            "seq": 3,
            "type": "request",
          }
        `);
    }),
  );
});
