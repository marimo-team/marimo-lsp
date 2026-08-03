import { Data } from "effect";

import type * as Api from "../schemas/Models.gen.ts";

export type NotebookSourceFailure = Exclude<
  Api.DeserializeResult,
  { readonly kind: "success" }
>;

export class NotebookSourceError extends Data.TaggedError(
  "NotebookSourceError",
)<{
  readonly failure: NotebookSourceFailure;
}> {}

export function notebookSourceFailureMessage(
  failure: NotebookSourceFailure,
): string {
  switch (failure.kind) {
    case "invalid-syntax": {
      const location = failure.line === null ? "" : ` at line ${failure.line}`;
      return `This file can't be opened as a marimo notebook because it has a Python syntax error${location}.`;
    }
    case "convertible":
      return "This is not a native marimo notebook and must be converted first.";
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}
