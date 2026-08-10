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
  ) => WasmBridge;
  readonly destroy: () => void;
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

/** Owns the Pyodide bridge and its selected-Python process lifecycle. */
export class WasmBridgeRuntime {
  readonly #module: WasmModule;
  readonly #processes: Processes;
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
      const bridge = wasmModule.create_bridge(writeMessage, processCallbacks);
      this.#state = { status: "running", bridge };
    } catch (error) {
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
