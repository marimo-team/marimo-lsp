import { Effect } from "effect";

import type { NotebookCommandContext } from "../commands.ts";
import { publishMarimoNotebookGist } from "./publishMarimoNotebookGist.ts";

export const publishMarimoNotebook = Effect.fn("command.publishMarimoNotebook")(
  function* (context?: NotebookCommandContext) {
    yield* publishMarimoNotebookGist(context);
  },
);
