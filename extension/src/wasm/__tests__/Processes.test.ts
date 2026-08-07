import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { Processes } from "../Processes.ts";

it("reports a selected-Python spawn failure", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const exited = Promise.withResolvers<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>();
  const processes = new Processes({
    stdout: () => {},
    exited: (_processId, code, signal) => exited.resolve({ code, signal }),
  });

  processes.spawn("kernel", "/definitely-not-a-marimo-python", process.cwd());

  await expect(exited.promise).resolves.toEqual({ code: null, signal: null });
  expect(() => processes.write("kernel", new Uint8Array())).toThrow(
    "No process with id kernel",
  );
  stderr.mockRestore();
});
