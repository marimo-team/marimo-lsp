/**
 * Thin DAP proxy that sits between VS Code and debugpy.
 *
 * Connects to debugpy's TCP socket and rewrites source paths in DAP
 * messages so that notebook cell URIs map to the temp file paths
 * debugpy knows about.
 */
import * as NodeNet from "node:net";

import type { DebugProtocol } from "@vscode/debugprotocol";
import { Chunk, Data, Deferred, Effect, Runtime, Stream } from "effect";
import type * as vscode from "vscode";

import { VsCode } from "../platform/VsCode.ts";

class SocketError extends Data.TaggedError("SocketError")<{
  cause: Error;
}> {}

// ---------------------------------------------------------------------------
// DAP message type guards
// ---------------------------------------------------------------------------

function isSource(value: unknown): value is DebugProtocol.Source {
  return value != null && typeof value === "object" && "path" in value;
}

function isProtocolMessage(
  value: unknown,
): value is DebugProtocol.ProtocolMessage {
  return (
    value != null &&
    typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string" &&
    "seq" in value &&
    typeof value.seq === "number"
  );
}

function isRequestMessage(value: unknown): value is DebugProtocol.Request {
  return (
    isProtocolMessage(value) &&
    value.type === "request" &&
    "command" in value &&
    typeof value.command === "string"
  );
}

function isSetBreakpointsRequest(
  msg: DebugProtocol.Request,
): msg is DebugProtocol.SetBreakpointsRequest {
  return msg.command === "setBreakpoints";
}

function isConfigurationDoneRequest(
  msg: DebugProtocol.Request,
): msg is DebugProtocol.ConfigurationDoneRequest {
  return msg.command === "configurationDone";
}

// ---------------------------------------------------------------------------
// Source mapping
// ---------------------------------------------------------------------------

/** Maps cell document URIs to debugpy temp file paths and vice versa. */
interface SourceMapping {
  /** cell document URI string -> debugpy temp file path */
  cellToFile: ReadonlyMap<string, string>;
  /** debugpy temp file path -> cell document URI string */
  fileToCell: ReadonlyMap<string, string>;
}

export function createSourceMapping(
  cellMappings: Record<string, string>,
): SourceMapping {
  const cellToFile = new Map<string, string>();
  const fileToCell = new Map<string, string>();
  for (const [cellUri, filePath] of Object.entries(cellMappings)) {
    cellToFile.set(cellUri, filePath);
    fileToCell.set(filePath, cellUri);
  }
  return { cellToFile, fileToCell };
}

// ---------------------------------------------------------------------------
// DAP framing
// ---------------------------------------------------------------------------

/** Extract complete Content-Length framed DAP messages from a buffer. */
function extractDapMessages(buffer: string): {
  messages: Array<unknown>;
  remaining: string;
  skipped: number;
} {
  const messages: Array<unknown> = [];
  let buf = buffer;
  let skipped = 0;

  while (true) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const header = buf.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buf = buf.slice(headerEnd + 4);
      skipped++;
      continue;
    }

    const contentLength = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buf.length < bodyStart + contentLength) break;

    const body = buf.slice(bodyStart, bodyStart + contentLength);
    buf = buf.slice(bodyStart + contentLength);

    try {
      messages.push(JSON.parse(body));
    } catch {
      skipped++;
    }
  }

  return { messages, remaining: buf, skipped };
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

/**
 * Create a DAP proxy that connects to debugpy and rewrites source
 * paths between cell URIs and temp file paths.
 *
 * The socket and background processing fiber are tied to the
 * enclosing {@link Scope} — no manual cleanup needed.
 */
export const makeDapProxy = Effect.fn("makeDapProxy")(function* (
  host: string,
  port: number,
  mapping: SourceMapping,
) {
  const code = yield* VsCode;
  const runFork = Runtime.runFork(yield* Effect.runtime());
  const configurationDone = yield* Deferred.make<void>();
  const socket = yield* Effect.acquireRelease(
    Effect.sync(() => NodeNet.createConnection({ host, port })),
    (s) => Effect.sync(() => s.destroy()),
  );

  const emitter = yield* Effect.acquireRelease(
    Effect.sync(() => new code.EventEmitter<vscode.DebugProtocolMessage>()),
    (emitter) => Effect.sync(() => emitter.dispose()),
  );

  // Stream of framed DAP messages from the socket
  const dapMessages = Stream.async<unknown, SocketError>((emit) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const { messages, remaining, skipped } = extractDapMessages(buffer);
      buffer = remaining;
      if (skipped > 0) {
        runFork(
          Effect.logWarning("Skipped malformed DAP messages").pipe(
            Effect.annotateLogs({ skipped }),
          ),
        );
      }
      return emit.chunk(Chunk.fromIterable(messages));
    });
    socket.on("end", () => emit.end());
    socket.on("error", (err) => emit.fail(new SocketError({ cause: err })));
  });

  // Process incoming messages (debugpy -> VS Code) in a background fiber
  yield* dapMessages.pipe(
    Stream.filter(isProtocolMessage),
    Stream.runForEach((json) =>
      Effect.sync(() => {
        rewriteSourcePaths(json, mapping.fileToCell);
        emitter.fire(json as vscode.DebugProtocolMessage);
      }),
    ),
    Effect.catchAll((error) =>
      Effect.logError("Socket stream failed").pipe(
        Effect.annotateLogs({ error: String(error) }),
      ),
    ),
    Effect.forkScoped,
  );

  function sendToDebugpy(message: vscode.DebugProtocolMessage): void {
    const json = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n`;
    socket.write(header + json, "utf-8");
  }

  return {
    ready: Deferred.await(configurationDone),
    adapter: {
      onDidSendMessage: emitter.event,
      handleMessage(message: vscode.DebugProtocolMessage): void {
        if (isRequestMessage(message)) {
          if (isSetBreakpointsRequest(message)) {
            const { source } = message.arguments;
            if (source.path != null) {
              const mapped = mapping.cellToFile.get(source.path);
              if (mapped) {
                source.path = mapped;
              }
            }
          }

          if (isConfigurationDoneRequest(message)) {
            sendToDebugpy(message);
            runFork(Deferred.succeed(configurationDone, void 0));
            return;
          }
        }

        sendToDebugpy(message);
      },
    } satisfies Omit<vscode.DebugAdapter, "dispose">,
  };
});

// ---------------------------------------------------------------------------
// Path rewriting (pure)
// ---------------------------------------------------------------------------

/**
 * Walk a DAP message and rewrite any `source.path` strings found.
 *
 * Handles nested structures like stackTrace responses where source
 * appears inside `body.stackFrames[].source`.
 */
function rewriteSourcePaths(
  msg: DebugProtocol.ProtocolMessage,
  mapping: ReadonlyMap<string, string>,
): void {
  function walk(obj: unknown): void {
    if (obj == null || typeof obj !== "object") {
      return;
    }

    for (const [key, value] of Object.entries(obj)) {
      if (key === "source" && isSource(value) && value.path != null) {
        const mapped = mapping.get(value.path);
        if (mapped) {
          value.path = mapped;
        }
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          walk(item);
        }
      } else if (value != null && typeof value === "object") {
        walk(value);
      }
    }
  }

  walk(msg);
}
