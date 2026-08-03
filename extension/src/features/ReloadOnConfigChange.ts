import { Effect, Either, Layer, Option, Stream } from "effect";

import { MarimoCommands } from "../commands/MarimoCommands.ts";
import { NotebookRuntime } from "../kernel/NotebookRuntime.ts";
import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";

export const promptToRestartKernelForFileRootChange = Effect.fn(function* () {
  const code = yield* VsCode;

  const restart = yield* code.window.showInformationMessage(
    "The notebook file root changed. Restart the marimo kernel to apply it.",
    { items: ["Restart Kernel"] },
  );
  if (Option.isSome(restart) && restart.value === "Restart Kernel") {
    yield* code.commands.execute(MarimoCommands.restartKernel);
  }
});

/** Watches configuration changes that require an explicit reload or restart. */
export const watchForConfigurationChanges = Effect.fn(function* () {
  const code = yield* VsCode;
  const notebooks = yield* NotebookRuntime;
  const pendingFileRootChanges = new Set<string>();

  const promptForActiveAffectedSession = Effect.fn(function* () {
    const activeNotebook = Option.filterMap(
      yield* code.window.getActiveNotebookEditor(),
      (editor) => MarimoNotebookDocument.tryFrom(editor.notebook),
    );
    if (
      Option.isNone(activeNotebook) ||
      !pendingFileRootChanges.has(activeNotebook.value.id)
    ) {
      return;
    }

    pendingFileRootChanges.delete(activeNotebook.value.id);
    if (
      Option.isNone(yield* notebooks.getRuntimeSession(activeNotebook.value.id))
    ) {
      return;
    }
    yield* promptToRestartKernelForFileRootChange();
  });

  yield* Effect.forkScoped(
    code.workspace.configurationChanges().pipe(
      Stream.filter((event) => event.affectsConfiguration("marimo.telemetry")),
      Stream.runForEach(
        Effect.fn(function* () {
          const reload = yield* code.window.showInformationMessage(
            "Changing telemetry requires reloading the window to take effect.",
            { items: ["Reload Window"] },
          );

          if (Option.isSome(reload) && reload.value === "Reload Window") {
            yield* code.commands.executeVSCode("workbench.action.reloadWindow");
          }
        }),
      ),
    ),
  );

  yield* Effect.forkScoped(
    code.workspace.configurationChanges().pipe(
      Stream.filter((event) =>
        event.affectsConfiguration("marimo.disableManagedLanguageFeatures"),
      ),
      Stream.runForEach(
        Effect.fn(function* () {
          const reload = yield* code.window.showInformationMessage(
            "Changing managed language features requires reloading the window to take effect.",
            { items: ["Reload Window"] },
          );

          if (Option.isSome(reload) && reload.value === "Reload Window") {
            yield* code.commands.executeVSCode("workbench.action.reloadWindow");
          }
        }),
      ),
    ),
  );

  yield* Effect.forkScoped(
    code.workspace.configurationChanges().pipe(
      Stream.filter((event) =>
        event.affectsConfiguration("marimo.notebookFileRoot"),
      ),
      Stream.runForEach(
        Effect.fn(function* (event) {
          for (const { notebookId } of yield* notebooks.getRuntimeSessions()) {
            const uri = code.utils.parseUri(notebookId);
            if (
              Either.isRight(uri) &&
              event.affectsConfiguration("marimo.notebookFileRoot", uri.right)
            ) {
              pendingFileRootChanges.add(notebookId);
            }
          }
          yield* promptForActiveAffectedSession();
        }),
      ),
    ),
  );

  yield* Effect.forkScoped(
    code.window
      .activeNotebookEditorChanges()
      .pipe(Stream.runForEach(promptForActiveAffectedSession)),
  );
});

export const ReloadOnConfigChangeLive = Layer.scopedDiscard(
  watchForConfigurationChanges(),
);
