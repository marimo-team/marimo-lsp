import { Effect, Option } from "effect";

import type { NotebookCommandContext } from "../commands.ts";
import { VsCode } from "../platform/VsCode.ts";

/**
 * Resolve the notebook that originated a toolbar command. Commands launched
 * elsewhere fall back to the active notebook.
 */
export const getNotebookCommandEditor = Effect.fn(
  "command.getNotebookCommandEditor",
)(function* (context?: NotebookCommandContext) {
  const code = yield* VsCode;

  if (context !== undefined) {
    const target = context.notebookEditor.notebookUri.toString();
    const editor = (yield* code.window.getVisibleNotebookEditors()).find(
      (candidate) => candidate.notebook.uri.toString() === target,
    );
    return Option.fromNullable(editor);
  }

  return yield* code.window.getActiveNotebookEditor();
});
