import { Effect, Layer } from "effect";
import { NotebookSerializer } from "../services/NotebookSerializer.ts";
import { VsCode } from "../services/VsCode.ts";

/**
 * Registers VS Code commands for the marimo extension.
 */
export const RegisterCommandsLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const serializer = yield* NotebookSerializer;
    yield* Effect.logInfo("Setting up commands").pipe(
      Effect.annotateLogs({ component: "commands" }),
    );
    yield* code.commands.registerCommand(
      "marimo.newMarimoNotebook",
      Effect.gen(function* () {
        const doc = yield* code.workspace.createEmptyPythonNotebook(
          serializer.notebookType,
        );
        yield* code.window.use((api) => api.showNotebookDocument(doc));
        yield* Effect.logInfo("Created new marimo notebook").pipe(
          Effect.annotateLogs({
            component: "commands",
            uri: doc.uri.toString(),
          }),
        );
      }),
    );
  }),
);
