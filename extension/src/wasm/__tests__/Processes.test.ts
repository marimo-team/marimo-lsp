import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { Processes } from "../Processes.ts";

it("reports a selected-Python spawn failure", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const exited = Promise.withResolvers<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string | undefined;
  }>();
  const processes = new Processes({
    stdout: () => {},
    exited: (_processId, code, signal, processStderr) =>
      exited.resolve({ code, signal, stderr: processStderr }),
  });

  processes.spawn("kernel", "/definitely-not-a-marimo-python", process.cwd());

  const result = await exited.promise;
  expect(result.code).not.toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stderr).toContain("definitely-not-a-marimo-python");
  expect(() => processes.write("kernel", new Uint8Array())).toThrow(
    "No process with id kernel",
  );
  stderr.mockRestore();
});

it("drains stdout before reporting process exit", () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  const spawn = vi.fn(() => child);
  const events: string[] = [];
  const processes = new Processes(
    {
      stdout: (_processId, chunk) => events.push(Buffer.from(chunk).toString()),
      exited: () => events.push("exited"),
    },
    spawn,
  );

  processes.spawn("kernel", "/python", "/workspace");
  child.emit("exit", 0, null);
  child.stdout.write("final output");

  expect(events).toEqual(["final output"]);

  child.emit("close", 0, null);
  expect(events).toEqual(["final output", "exited"]);
});

it("includes captured stderr when reporting process exit", () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  const spawn = vi.fn(() => child);
  const captured: Array<string | undefined> = [];
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const processes = new Processes(
    {
      stdout: () => {},
      exited: (_processId, _code, _signal, processStderr) =>
        captured.push(processStderr),
    },
    spawn,
  );

  processes.spawn("kernel", "/python", "/workspace");
  child.stderr.write("Traceback: missing dependency\n");
  child.emit("close", 1, null);

  expect(captured).toEqual(["Traceback: missing dependency"]);
  stderr.mockRestore();
});
