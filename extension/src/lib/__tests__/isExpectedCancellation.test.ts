import { describe, expect, it } from "@effect/vitest";
import { Cause } from "effect";

import { isExpectedCancellation } from "../isExpectedCancellation.ts";

const canceled = () => {
  const error = new Error("Canceled");
  error.name = "Canceled";
  return error;
};

describe("isExpectedCancellation", () => {
  it("accepts interruptions and canceled failures or defects", () => {
    expect(isExpectedCancellation(Cause.interrupt())).toBe(true);
    expect(isExpectedCancellation(Cause.fail(canceled()))).toBe(true);
    expect(isExpectedCancellation(Cause.die(canceled()))).toBe(true);
  });

  it("rejects empty causes and ordinary failures", () => {
    expect(isExpectedCancellation(Cause.empty)).toBe(false);
    expect(isExpectedCancellation(Cause.fail(new Error("boom")))).toBe(false);
    expect(isExpectedCancellation(Cause.die(new Error("boom")))).toBe(false);
  });

  it("does not suppress a real failure mixed with cancellation", () => {
    const cause = Cause.fromReasons([
      Cause.makeInterruptReason(),
      Cause.makeDieReason(canceled()),
      Cause.makeFailReason(new Error("boom")),
    ]);

    expect(isExpectedCancellation(cause)).toBe(false);
  });
});
