/**
 * Thin DAP proxy that sits between VS Code and debugpy.
 *
 * Connects to debugpy's TCP socket and rewrites source paths in DAP messages
 * so that notebook cell URIs map to the temp file paths debugpy knows about.
 *
 * Implements {@link vscode.DebugAdapter} for use with
 * {@link vscode.DebugAdapterInlineImplementation}.
 */
import * as NodeNet from "node:net";

import { Option, Schema } from "effect";
import type * as vscode from "vscode";

// ---------------------------------------------------------------------------
// DAP message schemas (only the shapes we need to detect)
// ---------------------------------------------------------------------------

const SetBreakpointsRequest = Schema.Struct({
  type: Schema.Literal("request"),
  command: Schema.Literal("setBreakpoints"),
  arguments: Schema.Struct({
    source: Schema.Struct({ path: Schema.String }),
  }),
});

const ConfigurationDoneRequest = Schema.Struct({
  type: Schema.Literal("request"),
  command: Schema.Literal("configurationDone"),
});

const ProtocolMessage = Schema.Struct({
  type: Schema.String,
  seq: Schema.Number,
});

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
// Proxy
// ---------------------------------------------------------------------------

const decodeSetBreakpoints = Schema.decodeUnknownOption(SetBreakpointsRequest);
const decodeConfigurationDone = Schema.decodeUnknownOption(
  ConfigurationDoneRequest,
);
const decodeProtocolMessage = Schema.decodeUnknownOption(ProtocolMessage);

export class MarimoDebugProxy implements vscode.DebugAdapter {
  readonly #emitter: vscode.EventEmitter<vscode.DebugProtocolMessage>;
  readonly #socket: NodeNet.Socket;
  readonly #mapping: SourceMapping;
  readonly #onConfigurationDone: () => void;
  #buffer = "";

  readonly onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage>;

  constructor(
    host: string,
    port: number,
    mapping: SourceMapping,
    sendMessage: vscode.EventEmitter<vscode.DebugProtocolMessage>,
    onConfigurationDone: () => void,
  ) {
    this.#emitter = sendMessage;
    this.onDidSendMessage = this.#emitter.event;
    this.#mapping = mapping;
    this.#onConfigurationDone = onConfigurationDone;
    this.#socket = NodeNet.createConnection({ host, port });

    this.#socket.on("data", (chunk: Buffer) => {
      this.#buffer += chunk.toString("utf-8");
      this.#drainBuffer();
    });

    this.#socket.on("error", (err) => {
      console.error("[MarimoDebugProxy] socket error:", err);
    });
  }

  /** VS Code -> debugpy */
  handleMessage(message: vscode.DebugProtocolMessage): void {
    // setBreakpoints: rewrite source.path from cell URI to temp file
    const sbp = decodeSetBreakpoints(message);
    if (Option.isSome(sbp)) {
      const { source } = sbp.value.arguments;
      const mapped = this.#mapping.cellToFile.get(source.path);
      if (mapped) {
        this.#sendToDebugpy({
          ...sbp.value,
          arguments: {
            ...sbp.value.arguments,
            source: { ...source, path: mapped },
          },
        });
        return;
      }
    }

    // configurationDone: forward to debugpy, then trigger cell execution
    if (Option.isSome(decodeConfigurationDone(message))) {
      this.#sendToDebugpy(message);
      this.#onConfigurationDone();
      return;
    }

    this.#sendToDebugpy(message);
  }

  dispose(): void {
    this.#socket.destroy();
    this.#emitter.dispose();
  }

  #sendToDebugpy(message: vscode.DebugProtocolMessage): void {
    const json = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n`;
    this.#socket.write(header + json, "utf-8");
  }

  /** Parse Content-Length framed DAP messages from the TCP buffer */
  #drainBuffer(): void {
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.#buffer.slice(0, headerEnd);
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.#buffer = this.#buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.#buffer.length < bodyStart + contentLength) break;

      const body = this.#buffer.slice(bodyStart, bodyStart + contentLength);
      this.#buffer = this.#buffer.slice(bodyStart + contentLength);

      try {
        const json: unknown = JSON.parse(body);
        const msg = decodeProtocolMessage(json);
        if (Option.isNone(msg)) continue;

        // Rewrite source paths in responses/events from debugpy
        this.#rewriteSourcePaths(json, this.#mapping.fileToCell);

        this.#emitter.fire(msg.value);
      } catch {
        console.error("[MarimoDebugProxy] failed to parse DAP message:", body);
      }
    }
  }

  /**
   * Walk a raw DAP message and rewrite any `source.path` strings found.
   *
   * Handles nested structures like stackTrace responses where source
   * appears inside `body.stackFrames[].source`.
   */
  #rewriteSourcePaths(
    obj: unknown,
    mapping: ReadonlyMap<string, string>,
  ): void {
    if (obj == null || typeof obj !== "object") return;

    for (const [key, value] of Object.entries(obj)) {
      if (key === "source" && value != null && typeof value === "object") {
        const source = value as Record<string, unknown>;
        if (typeof source.path === "string") {
          const mapped = mapping.get(source.path);
          if (mapped) {
            source.path = mapped;
          }
        }
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          this.#rewriteSourcePaths(item, mapping);
        }
      } else if (value != null && typeof value === "object") {
        this.#rewriteSourcePaths(value, mapping);
      }
    }
  }
}
