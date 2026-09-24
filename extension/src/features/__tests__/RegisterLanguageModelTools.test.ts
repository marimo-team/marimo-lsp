import * as Vitest from "@effect/vitest";
import { Effect } from "effect";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import { SCRATCH_CELL_ID } from "../../constants.ts";
import { cellId } from "../../lib/__tests__/branded.ts";
import * as VsCode from "../../platform/VsCode.ts";
import type { CellOperationNotification } from "../../types.ts";
import * as RegisterLanguageModelTools from "../RegisterLanguageModelTools.ts";

const effectIt = EffectTest.make(TestVsCode.layer);

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

Vitest.describe("consoleText", () => {
  Vitest.it("concatenates stdout/stderr data in order", () => {
    const op = makeOp([out("stdout", "70"), out("stderr", "warn")]);
    Vitest.expect(RegisterLanguageModelTools.consoleText(op)).toBe("70warn");
  });

  Vitest.it("accepts a single (non-array) console output", () => {
    Vitest.expect(
      RegisterLanguageModelTools.consoleText(makeOp(out("stdout", "hi"))),
    ).toBe("hi");
  });

  Vitest.it(
    "skips non-stdout/stderr channels, matching SSE _format_console",
    () => {
      const op = makeOp([out("stdin", "Enter: "), out("stdout", "value")]);
      Vitest.expect(RegisterLanguageModelTools.consoleText(op)).toBe("value");
    },
  );

  Vitest.it("returns empty string when there is no console", () => {
    Vitest.expect(RegisterLanguageModelTools.consoleText(makeOp(null))).toBe(
      "",
    );
    Vitest.expect(
      RegisterLanguageModelTools.consoleText(makeOp(undefined)),
    ).toBe("");
  });
});

Vitest.describe("scratchpadResultText", () => {
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

  effectIt.effect(
    "renders the scratch cell's own value, not a cascade cell's",
    Effect.fn(function* () {
      const code = yield* VsCode.Service;
      const text = RegisterLanguageModelTools.scratchpadResultText(
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

      // The scratch cell gives its rendered value and its console.
      Vitest.expect(text).toContain("SCRATCH");
      Vitest.expect(text).toContain("scratch-stdout");
      // A cascade cell gives only its console. It does not give its
      // rendered value.
      Vitest.expect(text).toContain("cascade-stdout");
      Vitest.expect(text).not.toContain("CASCADE");
    }),
  );
});
