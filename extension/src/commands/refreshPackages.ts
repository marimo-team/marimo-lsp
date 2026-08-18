import { Effect, Option, Scope } from "effect";

import { defineCommand } from "../commands.ts";
import { NotebookDependencies } from "../notebook/NotebookDependencies.ts";
import { NotebookDocumentSessions } from "../notebook/NotebookDocumentSessions.ts";
import { NotebookEditorRegistry } from "../notebook/NotebookEditorRegistry.ts";
import { NotebookSessionResources } from "../notebook/NotebookSessionResources.ts";
import { MarimoCommands } from "./MarimoCommands.ts";

const handler = Effect.fn("command.refreshPackages")(function* () {
  const editorRegistry = yield* NotebookEditorRegistry;
  const documentSessions = yield* NotebookDocumentSessions;
  const sessionResources = yield* NotebookSessionResources;
  const activeNotebookUri = yield* editorRegistry.getActiveNotebookUri;
  if (Option.isNone(activeNotebookUri)) {
    yield* Effect.logWarning("No active notebook to refresh packages");
    return;
  }

  const notebookUri = activeNotebookUri.value;
  yield* Effect.logInfo("Refreshing packages").pipe(
    Effect.annotateLogs({ notebookUri }),
  );
  const session = documentSessions.current(notebookUri);
  if (Option.isNone(session)) {
    yield* Effect.logWarning("Active notebook session ended before refresh");
    return;
  }
  yield* sessionResources
    .runScoped(
      session.value,
      NotebookDependencies.pipe(
        Effect.flatMap((dependencies) => dependencies.refresh),
      ),
    )
    .pipe(
      Scope.provide(session.value.scope),
      Effect.catchTag("NotebookDocumentSessionEndedError", () => Effect.void),
    );
});

export default defineCommand(MarimoCommands.refreshPackages, handler);
