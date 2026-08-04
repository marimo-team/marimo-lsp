import { Effect } from "effect";

import type { NotebookToolbarContext } from "./NotebookCommandTarget.ts";
import { publishMarimoNotebookGist } from "./publishMarimoNotebookGist.ts";

export const publishMarimoNotebook = Effect.fn("command.publishMarimoNotebook")(
  function* (context?: NotebookToolbarContext) {
    yield* publishMarimoNotebookGist(context);
  },
);
