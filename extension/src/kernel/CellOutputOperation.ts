import { Data, Effect } from "effect";

export type CellOutputOperation =
  | "appendOutput"
  | "clearOutput"
  | "replaceOutput"
  | "replaceOutputItems"
  | "synchronize";

export class CellOutputOperationError extends Data.TaggedError(
  "CellOutputOperationError",
)<{
  readonly operation: CellOutputOperation;
  readonly cause: unknown;
}> {}

export const tryCellOutputOperation = <A>(
  operation: CellOutputOperation,
  run: () => PromiseLike<A>,
): Effect.Effect<A, CellOutputOperationError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new CellOutputOperationError({ operation, cause }),
  });
