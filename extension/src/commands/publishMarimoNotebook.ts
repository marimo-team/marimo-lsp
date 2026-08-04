import { Effect, Option } from "effect";

import { defineCommand } from "../commands.ts";
import { VsCode } from "../platform/VsCode.ts";
import type { NotebookTarget } from "./Invocation.ts";
import { MarimoCommands } from "./MarimoCommands.ts";
import { publishMarimoNotebookGist } from "./publishMarimoNotebookGist.ts";

const handler = Effect.fn("command.publishMarimoNotebook")(function* (
  target: Option.Option<NotebookTarget>,
) {
  if (Option.isNone(target)) {
    const code = yield* VsCode;
    yield* code.window.showWarningMessage(
      "Must have an open marimo notebook to publish Gist.",
    );
    return;
  }
  yield* publishMarimoNotebookGist(target.value.document);
});

export default defineCommand(MarimoCommands.publishMarimoNotebook, handler);
