import { Effect } from "effect";

import { defineMarimoCommand } from "../commands.ts";
import { GeneratedMarimoCommands } from "./MarimoCommands.gen.ts";
import type { NotebookToolbarContext } from "./NotebookCommandTarget.ts";
import { withOptionalNotebookToolbarContext } from "./NotebookCommandTarget.ts";
import { publishMarimoNotebookGist } from "./publishMarimoNotebookGist.ts";

const publishMarimoNotebook = Effect.fn("command.publishMarimoNotebook")(
  function* (context?: NotebookToolbarContext) {
    yield* publishMarimoNotebookGist(context);
  },
);

export const publishMarimoNotebookCommand = defineMarimoCommand(
  withOptionalNotebookToolbarContext(
    GeneratedMarimoCommands.publishMarimoNotebook,
  ),
  publishMarimoNotebook,
);
