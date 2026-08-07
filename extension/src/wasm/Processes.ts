import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import type { Writable } from "node:stream";

interface ProcessState {
  readonly child: NodeChildProcess.ChildProcess;
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

  constructor(callbacks: ProcessCallbacks) {
    this.#callbacks = callbacks;
  }

  spawn(processId: string, executable: string, workingDirectory: string): void {
    const script = NodePath.join(
      __dirname,
      "..",
      "resources",
      "wasm",
      "kernel.py",
    );
    const child = NodeChildProcess.spawn(executable, [script], {
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
      exited(null, null);
    });
    child.once("exit", exited);
  }

  write(processId: string, chunk: Uint8Array): void {
    const state = this.#processes.get(processId);
    if (state === undefined) throw new Error(`No process with id ${processId}`);
    state.input.write(chunk);
  }

  close(processId: string): void {
    const state = this.#processes.get(processId);
    if (state === undefined) return;
    state.expectedClose = true;
    state.input.end();
  }

  closeAll(): void {
    for (const processId of this.#processes.keys()) this.close(processId);
  }
}
