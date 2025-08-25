import * as process from "node:process";

export class AssertionError extends Error {
  override name = "AssertionError";
}

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
 * @throws {Error} If `expression` is falsy.
 */
export function assert(expression: unknown, msg?: string): asserts expression {
  if (!expression) {
    if (process.env.NODE_ENV === "development") {
      // biome-ignore lint/suspicious/noDebugger: Triggers a breakpoint in development; stripped out in production builds.
      debugger;
    }

    throw new AssertionError(msg);
  }
}
