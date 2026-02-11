import { Data } from "effect";
import * as process from "node:process";

export class AssertionError extends Data.TaggedError("AssertionError")<{
  message: unknown;
}> {}

/**
 * Make an assertion.
 *
 * If the expression is falsy, an error is thrown with the provided message.
 *
 * @example
 * ```ts
 * const value: boolean = Math.random() <= 0.5;
 * invariant(value, "Value is greater than 0.5");
 * value; // true
 * ```
 *
 * @example
 * ```ts
 * const user: { name?: string } = await fetchUser();
 * invariant(user.name, "User missing name");
 * user.name; // string
 * ```
 *
 * @param expression - The condition to check.
 * @param msg - The error message to throw if the assertion fails.
 * @throws {@link AssertionError} If `expression` is falsy.
 */
export function assert(
  expression: unknown,
  message?: string,
): asserts expression {
  if (!expression) {
    if (process.env.NODE_ENV === "development") {
      // oxlint-disable-next-line no-debugger: Triggers a breakpoint in development; stripped out in production builds.
      debugger;
    }

    throw new AssertionError({ message });
  }
}

/**
 * Marks a code path as unreachable.
 *
 * This function should be used in places that are logically impossible
 * to execute (e.g. exhaustive `switch` statements over discriminated unions).
 *
 * If it is ever reached at runtime, an error is thrown.
 *
 * @example
 * ```ts
 * type Direction = "north" | "south" | "east" | "west";
 *
 * function turn(dir: Direction): number {
 *   switch (dir) {
 *     case "north": return 0;
 *     case "east": return 90;
 *     case "south": return 180;
 *     case "west": return 270;
 *   }
 *   unreachable(dir, "Unhandled direction");
 * }
 * ```
 *
 * @param neverValue - A `never`-typed value used to enforce exhaustiveness
 *   in TypeScript. If ever passed at runtime, assumptions about control
 *   flow are incorrect.
 * @param context - Optional context for the error.
 * @throws {@link AssertionError} Always throws if executed.
 */
export function unreachable(neverValue: never, context?: string): never {
  assert(
    false,
    `Entered unreachable code` +
      (context ? ` [${context}]` : "") +
      `: ${safeRepr(neverValue)}`,
  );
}

/**
 * Logs a message when unreachable code is reached.
 *
 * @param neverValue - A `never`-typed value used to enforce exhaustiveness
 *   in TypeScript. If ever passed at runtime, assumptions about control
 *   flow are incorrect.
 * @param context - Optional context for the error.
 */
export function logUnreachable(neverValue: never, context?: string): void {
  console.error(
    `Entered unreachable code` +
      (context ? ` [${context}]` : "") +
      `: ${safeRepr(neverValue)}`,
  );
}

function safeRepr(x: unknown): string {
  try {
    if (typeof x === "string") {
      return x;
    }
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}
