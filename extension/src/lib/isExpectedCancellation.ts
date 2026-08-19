import { Cause } from "effect";

const isCanceledError = (value: unknown): boolean =>
  value instanceof Error && value.name === "Canceled";

/**
 * Returns whether every reason in a non-empty cause is expected cancellation
 * control flow. A cause that also contains a real failure is never suppressed.
 */
export function isExpectedCancellation(cause: Cause.Cause<unknown>): boolean {
  return (
    cause.reasons.length > 0 &&
    cause.reasons.every((reason) => {
      if (Cause.isInterruptReason(reason)) return true;
      if (Cause.isFailReason(reason)) return isCanceledError(reason.error);
      if (Cause.isDieReason(reason)) return isCanceledError(reason.defect);
      return false;
    })
  );
}
