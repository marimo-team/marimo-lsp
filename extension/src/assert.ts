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
 * @param msg - Optional error message. Defaults to `"Entered unreachable code"`.
 * @throws {Error} Always throws if executed.
 */
export function unreachable(_: never, msg?: string): never {
  assert(false, msg ?? "Entered unreachable code");
}
