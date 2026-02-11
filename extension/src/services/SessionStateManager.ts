import { Effect, Option, Stream } from "effect";

import { MarimoNotebookDocument } from "../schemas.ts";
import { ControllerRegistry } from "./ControllerRegistry.ts";
import { NotebookEditorRegistry } from "./NotebookEditorRegistry.ts";
import { VsCode } from "./VsCode.ts";

/**
 * Manages session state for notebooks.
 *
 * Tracks whether the active notebook has a kernel/controller selected
 * and updates the VSCode context key "marimo.notebook.hasKernel" for UI enablement.
 */
export class SessionStateManager extends Effect.Service<SessionStateManager>()(
  "SessionStateManager",
  {
    dependencies: [NotebookEditorRegistry.Default, ControllerRegistry.Default],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const editorRegistry = yield* NotebookEditorRegistry;
      const controllerRegistry = yield* ControllerRegistry;

      // Helper to update context based on current state
      const updateContext = Effect.fnUntraced(function* () {
        const activeNotebook = Option.filterMap(
          yield* code.window.getActiveNotebookEditor(),
          (editor) => MarimoNotebookDocument.tryFrom(editor.notebook),
        );

        // Check if the active notebook has a selected controller
        const hasKernel = yield* Effect.gen(function* () {
          if (Option.isNone(activeNotebook)) {
            return false;
          }

          const controller = yield* controllerRegistry.getActiveController(
            activeNotebook.value,
          );

          return Option.isSome(controller);
        }).pipe(Effect.orElseSucceed(() => false));

        yield* code.commands.setContext("marimo.notebook.hasKernel", hasKernel);
        yield* Effect.logDebug("Updated hasKernel context").pipe(
          Effect.annotateLogs({ hasKernel }),
        );
      });

      // Set initial context state
      yield* Effect.forkScoped(updateContext());

      // Subscribe to active notebook changes to update VSCode context
      yield* Effect.forkScoped(
        editorRegistry
          .streamActiveNotebookChanges()
          .pipe(Stream.mapEffect(updateContext), Stream.runDrain),
      );

      return {};
    }).pipe(Effect.annotateLogs("service", "SessionStateManager")),
  },
) {}
