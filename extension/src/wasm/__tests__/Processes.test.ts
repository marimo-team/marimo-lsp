import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vite-plus/test";

import { Processes } from "../Processes.ts";

it.live(
  "reports a selected-Python spawn failure",
  Effect.fn(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(process.stderr, "write").mockReturnValue(true),
      ),
      (stderr) => Effect.sync(() => stderr.mockRestore()),
    );

    const result = yield* Effect.callback<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stderr: string | undefined;
      processes: Processes;
    }>((resume) => {
      const processes = new Processes({
        stdout: () => {},
        exited: (_processId, code, signal, processStderr) =>
          resume(
            Effect.succeed({
              code,
              signal,
              stderr: processStderr,
              processes,
            }),
          ),
      });

      processes.spawn(
        "kernel",
        "/definitely-not-a-marimo-python",
        process.cwd(),
      );
    });

    expect(result.code).not.toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain("definitely-not-a-marimo-python");
    expect(() => result.processes.write("kernel", new Uint8Array())).toThrow(
      "No process with id kernel",
    );
  }),
);

it("drains stdout before reporting process exit", () => {
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    stdin: new NodeStream.PassThrough(),
    stdout: new NodeStream.PassThrough(),
    stderr: new NodeStream.PassThrough(),
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
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    stdin: new NodeStream.PassThrough(),
    stdout: new NodeStream.PassThrough(),
    stderr: new NodeStream.PassThrough(),
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
