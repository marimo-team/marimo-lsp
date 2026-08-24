import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import { Processes } from "./Processes.ts";

interface WasmBridge {
  readonly handle_message: (messageJson: string) => Promise<void>;
  readonly handle_kernel_bytes: (processId: string, chunk: Uint8Array) => void;
  readonly handle_kernel_exit: (
    processId: string,
    code: number | null,
    signal: string | null,
    stderr: string | null,
  ) => void;
  readonly close: () => void;
  readonly destroy: () => void;
}

interface BytesProxy {
  readonly toJs: () => unknown;
  readonly destroy: () => void;
}

export interface WasmModule {
  readonly create_bridge: (
    writeMessage: (messageJson: string) => void,
    processes: object,
    savedSessions: object,
  ) => WasmBridge;
  readonly destroy: () => void;
}

interface SavedSessionReplacement {
  readonly target: string;
  readonly temporary: string;
  descriptor: number | undefined;
  writing: Promise<void> | undefined;
  discarded: boolean;
}

type RuntimeState =
  | { readonly status: "starting" }
  | { readonly status: "running"; readonly bridge: WasmBridge }
  | { readonly status: "closing" }
  | { readonly status: "closed" };

function takeBytes(value: Uint8Array | BytesProxy): Uint8Array {
  if (value instanceof Uint8Array) return value;
  const converted = value.toJs();
  value.destroy();
  if (!(converted instanceof Uint8Array)) {
    throw new TypeError("Python bytes did not convert to Uint8Array");
  }
  return converted;
}

export class SavedSessionFiles {
  readonly #replacements = new Map<string, SavedSessionReplacement>();
  #closed = false;

  async read(target: string): Promise<string | null> {
    this.#assertOpen();
    this.#assertTarget(target);
    try {
      return await NodeFs.promises.readFile(target, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }

  create(target: string): string {
    this.#assertOpen();
    this.#assertTarget(target);
    const directory = NodePath.dirname(target);
    NodeFs.mkdirSync(directory, { recursive: true });
    const replacement = NodeCrypto.randomUUID();
    const temporary = NodePath.join(
      directory,
      `.${NodePath.basename(target)}.${replacement}.tmp`,
    );
    try {
      let mode: number | undefined;
      try {
        mode = NodeFs.statSync(target).mode & 0o777;
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
      const descriptor = NodeFs.openSync(temporary, "wx", mode);
      try {
        if (mode !== undefined && process.platform !== "win32") {
          NodeFs.fchmodSync(descriptor, mode);
        }
      } catch (error) {
        NodeFs.closeSync(descriptor);
        throw error;
      }
      this.#replacements.set(replacement, {
        target,
        temporary,
        descriptor,
        writing: undefined,
        discarded: false,
      });
    } catch (error) {
      NodeFs.rmSync(temporary, { force: true });
      throw error;
    }
    return replacement;
  }

  write(replacement: string, contents: string): Promise<void> {
    this.#assertOpen();
    const pending = this.#requireReplacement(replacement);
    const descriptor = pending.descriptor;
    if (pending.writing !== undefined || descriptor === undefined) {
      throw new Error("Saved session replacement is already being written");
    }
    const write = new Promise<void>((resolve, reject) => {
      NodeFs.writeFile(descriptor, contents, { encoding: "utf8" }, (error) => {
        if (error === null) resolve();
        else reject(error);
      });
    }).finally(() => {
      pending.writing = undefined;
      if (pending.discarded) {
        this.#discardReplacement(replacement, pending);
      }
    });
    pending.writing = write;
    return write;
  }

  commit(replacement: string): void {
    this.#assertOpen();
    const pending = this.#requireReplacement(replacement);
    if (pending.writing !== undefined || pending.descriptor === undefined) {
      throw new Error("Saved session replacement is not ready to commit");
    }
    try {
      NodeFs.fsyncSync(pending.descriptor);
      NodeFs.closeSync(pending.descriptor);
      pending.descriptor = undefined;
      NodeFs.renameSync(pending.temporary, pending.target);
      this.#replacements.delete(replacement);
    } catch (error) {
      this.#discardReplacement(replacement, pending);
      throw error;
    }
  }

  discard(replacement: string): void {
    const pending = this.#replacements.get(replacement);
    if (pending === undefined) return;
    if (pending.writing !== undefined) {
      pending.discarded = true;
      return;
    }
    this.#discardReplacement(replacement, pending);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [replacement, pending] of [...this.#replacements]) {
      if (pending.writing !== undefined) {
        pending.discarded = true;
      } else {
        this.#discardReplacement(replacement, pending);
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("Saved session files are closed");
    }
  }

  #assertTarget(target: string): void {
    if (!NodePath.isAbsolute(target)) {
      throw new TypeError("Saved session path must be absolute");
    }
  }

  #requireReplacement(replacement: string): SavedSessionReplacement {
    const pending = this.#replacements.get(replacement);
    if (pending === undefined) {
      throw new Error("Unknown saved session replacement");
    }
    return pending;
  }

  #discardReplacement(
    replacement: string,
    pending: SavedSessionReplacement,
  ): void {
    if (pending.descriptor !== undefined) {
      NodeFs.closeSync(pending.descriptor);
      pending.descriptor = undefined;
    }
    NodeFs.rmSync(pending.temporary, { force: true });
    this.#replacements.delete(replacement);
  }
}

/** Owns the Pyodide bridge and its selected-Python process lifecycle. */
export class WasmBridgeRuntime {
  readonly #module: WasmModule;
  readonly #processes: Processes;
  readonly #savedSessions = new SavedSessionFiles();
  #state: RuntimeState = { status: "starting" };

  constructor(
    wasmModule: WasmModule,
    writeMessage: (messageJson: string) => void,
  ) {
    this.#module = wasmModule;
    this.#processes = new Processes({
      stdout: (processId, chunk) => {
        const state = this.#state;
        if (state.status === "running") {
          state.bridge.handle_kernel_bytes(processId, chunk);
        }
      },
      exited: (processId, code, signal, stderr) => {
        const state = this.#state;
        if (state.status === "running") {
          state.bridge.handle_kernel_exit(
            processId,
            code,
            signal,
            stderr ?? null,
          );
        }
      },
    });
    const processCallbacks = {
      spawn: (
        processId: string,
        executable: string,
        workingDirectory: string,
      ) => this.#processes.spawn(processId, executable, workingDirectory),
      write: (processId: string, chunk: Uint8Array | BytesProxy) => {
        this.#processes.write(processId, takeBytes(chunk));
      },
      close: (processId: string) => this.#processes.close(processId),
    };

    try {
      const bridge = wasmModule.create_bridge(
        writeMessage,
        processCallbacks,
        this.#savedSessions,
      );
      this.#state = { status: "running", bridge };
    } catch (error) {
      this.#savedSessions.close();
      this.#processes.closeAll();
      this.#module.destroy();
      this.#state = { status: "closed" };
      throw error;
    }
  }

  handleMessage(messageJson: string): Promise<void> {
    const state = this.#state;
    if (state.status !== "running") {
      return Promise.reject(
        new Error(`Cannot handle a message while bridge is ${state.status}`),
      );
    }
    return state.bridge.handle_message(messageJson);
  }

  close(): void {
    const state = this.#state;
    if (state.status !== "running") return;
    this.#state = { status: "closing" };
    try {
      // The Python bridge writes each kernel's final Close frame before it
      // asks Processes to end that kernel's stdin.
      state.bridge.close();
    } finally {
      try {
        this.#savedSessions.close();
        // Also release any process that was not tracked by the Python bridge.
        this.#processes.closeAll();
      } finally {
        try {
          state.bridge.destroy();
        } finally {
          this.#module.destroy();
          this.#state = { status: "closed" };
        }
      }
    }
  }
}
