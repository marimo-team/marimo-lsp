import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { SCRATCH_CELL_ID } from "../../constants.ts";
import { cellId } from "../../lib/__tests__/branded.ts";
import { VsCode } from "../../platform/VsCode.ts";
import type { CellOperationNotification } from "../../types.ts";
import {
  consoleText,
  scratchpadResultText,
} from "../RegisterLanguageModelTools.ts";

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

describe("scratchpadResultText", () => {
  const scratchOp = (
    console: CellOperationNotification["console"],
    output?: CellOperationNotification["output"],
  ): CellOperationNotification => ({
    op: "cell-op",
    cell_id: SCRATCH_CELL_ID,
    status: "idle",
    console,
    ...(output ? { output } : {}),
  });

  const rendered = (data: string) =>
    ({
      channel: "output",
      mimetype: "text/plain",
      data,
      timestamp: 0,
    }) as const;

  it.effect(
    "renders the scratch cell's own value, not a cascade cell's",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.make({});

      const text = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        return scratchpadResultText(
          [
            scratchOp([out("stdout", "scratch-stdout")], rendered("SCRATCH")),
            {
              ...makeOp([out("stdout", "cascade-stdout")]),
              status: "idle",
              output: rendered("CASCADE"),
            },
          ],
          code,
        );
      }).pipe(Effect.provide(vscode.layer));

      // The scratch cell gives its rendered value and its console.
      expect(text).toContain("SCRATCH");
      expect(text).toContain("scratch-stdout");
      // A cascade cell gives only its console. It does not give its
      // rendered value.
      expect(text).toContain("cascade-stdout");
      expect(text).not.toContain("CASCADE");
    }),
  );
});
