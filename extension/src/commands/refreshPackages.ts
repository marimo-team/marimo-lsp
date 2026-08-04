import { Effect, Option } from "effect";

import { defineCommand } from "../commands.ts";
import { NotebookEditorRegistry } from "../notebook/NotebookEditorRegistry.ts";
import { PackagesService } from "../panel/packages/PackagesService.ts";
import { MarimoCommands } from "./MarimoCommands.ts";

const handler = Effect.fn("command.refreshPackages")(function* () {
  const editorRegistry = yield* NotebookEditorRegistry;
  const packages = yield* PackagesService;
  const activeNotebookUri = yield* editorRegistry.getActiveNotebookUri();
  if (Option.isNone(activeNotebookUri)) {
    yield* Effect.logWarning("No active notebook to refresh packages");
    return;
  }

  const notebookUri = activeNotebookUri.value;
  yield* Effect.logInfo("Refreshing packages").pipe(
    Effect.annotateLogs({ notebookUri }),
  );
  yield* packages.clearNotebook(notebookUri);
});

export default defineCommand(MarimoCommands.refreshPackages, handler);
