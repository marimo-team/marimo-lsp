import { Effect, ParseResult, Schema } from "effect";

/**
 * Ties a Schema to a command handler, returning an opaque (...args: unknown[]) => Effect
 * that decodes args[0] before calling the handler. Keeps schema and type contract local
 * to the command file rather than in a central registry.
 */
export function defineCommand<A, E, R>(
  schema: Schema.Schema<A>,
  handler: (arg: A) => Effect.Effect<unknown, E, R>,
): (
  ...args: unknown[]
) => Effect.Effect<unknown, E | ParseResult.ParseError, R> {
  return (...args) =>
    Schema.decodeUnknown(schema)(args[0]).pipe(Effect.flatMap(handler));
}
