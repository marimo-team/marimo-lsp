import { describe, expect, it } from "@effect/vitest";

import { cellId } from "../../lib/__tests__/branded.ts";
import type { CellOperationNotification } from "../../types.ts";
import { consoleText } from "../RegisterLanguageModelTools.ts";

const makeOp = (
  console: CellOperationNotification["console"],
): CellOperationNotification => ({
  op: "cell-op",
  cell_id: cellId("cell-1"),
  status: "running",
  console,
});

const out = (channel: "stdout" | "stderr" | "stdin", data: string) =>
  ({ channel, data, mimetype: "text/plain", timestamp: 0 }) as const;

describe("consoleText", () => {
  it("concatenates stdout/stderr data in order", () => {
    const op = makeOp([out("stdout", "70"), out("stderr", "warn")]);
    expect(consoleText(op)).toBe("70warn");
  });

  it("accepts a single (non-array) console output", () => {
    expect(consoleText(makeOp(out("stdout", "hi")))).toBe("hi");
  });

  it("skips non-stdout/stderr channels, matching SSE _format_console", () => {
    const op = makeOp([out("stdin", "Enter: "), out("stdout", "value")]);
    expect(consoleText(op)).toBe("value");
  });

  it("returns empty string when there is no console", () => {
    expect(consoleText(makeOp(null))).toBe("");
    expect(consoleText(makeOp(undefined))).toBe("");
  });
});
