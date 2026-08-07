import * as NodeChildProcess from "node:child_process";
import type { EventEmitter } from "node:events";
import * as NodePath from "node:path";
import type { Readable, Writable } from "node:stream";

interface SpawnedProcess extends EventEmitter {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(): boolean;
}

type SpawnProcess = (
  executable: string,
  args: string[],
  options: NodeChildProcess.SpawnOptions,
) => SpawnedProcess;

interface ProcessState {
  readonly child: SpawnedProcess;
  readonly input: Writable;
  expectedClose: boolean;
  exited: boolean;
}

interface ProcessCallbacks {
  readonly stdout: (processId: string, chunk: Uint8Array) => void;
  readonly exited: (
    processId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void;
}

/** Brokers opaque bytes between Pyodide and selected-Python processes. */
export class Processes {
  readonly #processes = new Map<string, ProcessState>();
  readonly #callbacks: ProcessCallbacks;
  readonly #spawn: SpawnProcess;

  constructor(
    callbacks: ProcessCallbacks,
    spawn: SpawnProcess = (executable, args, options) =>
      NodeChildProcess.spawn(executable, args, options),
  ) {
    this.#callbacks = callbacks;
    this.#spawn = spawn;
  }

  spawn(processId: string, executable: string, workingDirectory: string): void {
    const script = NodePath.join(
      __dirname,
      "..",
      "resources",
      "wasm",
      "kernel.py",
    );
    const child = this.#spawn(executable, [script], {
      cwd: workingDirectory,
      // Keep smoke tests from writing bytecode into packaged resources.
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.stdin === null || child.stdout === null) {
      child.kill();
      throw new Error("Kernel process did not expose stdio pipes");
    }

    const state: ProcessState = {
      child,
      input: child.stdin,
      expectedClose: false,
      exited: false,
    };
    this.#processes.set(processId, state);
    child.stdout.on("data", (chunk: Buffer) => {
      this.#callbacks.stdout(
        processId,
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      );
    });
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      if (state.exited) return;
      state.exited = true;
      this.#processes.delete(processId);
      if (!state.expectedClose) this.#callbacks.exited(processId, code, signal);
    };
    child.once("error", (error) => {
      process.stderr.write(`${error.message}\n`);
    });
    // `exit` can precede the final stdout data. `close` is emitted only after
    // the process has exited and its stdio streams have closed.
    child.once("close", exited);
  }

  write(processId: string, chunk: Uint8Array): void {
    const state = this.#processes.get(processId);
    if (state === undefined) throw new Error(`No process with id ${processId}`);
    state.input.write(chunk);
  }

  close(processId: string): void {
    const state = this.#processes.get(processId);
    if (state === undefined || state.expectedClose) return;
    state.expectedClose = true;
    state.input.end();
  }

  closeAll(): void {
    for (const processId of this.#processes.keys()) this.close(processId);
  }
}
