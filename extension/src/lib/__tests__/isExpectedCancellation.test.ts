import * as Vitest from "@effect/vitest";
import { Cause } from "effect";

import { isExpectedCancellation } from "../isExpectedCancellation.ts";

const canceled = () => {
  const error = new Error("Canceled");
  error.name = "Canceled";
  return error;
};

Vitest.describe("isExpectedCancellation", () => {
  Vitest.it("accepts interruptions and canceled failures or defects", () => {
    Vitest.expect(isExpectedCancellation(Cause.interrupt())).toBe(true);
    Vitest.expect(isExpectedCancellation(Cause.fail(canceled()))).toBe(true);
    Vitest.expect(isExpectedCancellation(Cause.die(canceled()))).toBe(true);
  });

  Vitest.it("rejects empty causes and ordinary failures", () => {
    Vitest.expect(isExpectedCancellation(Cause.empty)).toBe(false);
    Vitest.expect(isExpectedCancellation(Cause.fail(new Error("boom")))).toBe(
      false,
    );
    Vitest.expect(isExpectedCancellation(Cause.die(new Error("boom")))).toBe(
      false,
    );
  });

  Vitest.it("does not suppress a real failure mixed with cancellation", () => {
    const cause = Cause.fromReasons([
      Cause.makeInterruptReason(),
      Cause.makeDieReason(canceled()),
      Cause.makeFailReason(new Error("boom")),
    ]);

    Vitest.expect(isExpectedCancellation(cause)).toBe(false);
  });
});
