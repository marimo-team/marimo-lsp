import { Effect, Layer, Option, Result, Stream } from "effect";

import restartKernel from "../commands/restartKernel.ts";
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
    yield* code.commands.execute(restartKernel.command);
  }
});

/** Watches configuration changes that require an explicit reload or restart. */
export const watchForConfigurationChanges = Effect.fn(function* () {
  const code = yield* VsCode;
  const notebooks = yield* NotebookRuntime;
  const pendingFileRootChanges = new Set<string>();

  const watchForWindowReload = Effect.fn(function* (
    sections: readonly string[],
    message: string,
  ) {
    yield* Effect.forkScoped(
      code.workspace.configurationChanges.pipe(
        Stream.filter((event) =>
          sections.some((section) => event.affectsConfiguration(section)),
        ),
        Stream.runForEach(
          Effect.fn(function* () {
            const reload = yield* code.window.showInformationMessage(message, {
              items: ["Reload Window"],
            });
            if (Option.isSome(reload) && reload.value === "Reload Window") {
              yield* code.commands.executeVSCode(
                "workbench.action.reloadWindow",
              );
            }
          }),
        ),
      ),
    );
  });

  const promptForActiveAffectedSession = Effect.fn(function* () {
    const activeNotebook = Option.flatMap(
      yield* code.window.getActiveNotebookEditor,
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

  yield* watchForWindowReload(
    ["marimo.telemetry"],
    "Changing telemetry requires reloading the window to take effect.",
  );
  yield* watchForWindowReload(
    ["marimo.disableManagedLanguageFeatures"],
    "Changing managed language features requires reloading the window to take effect.",
  );
  yield* watchForWindowReload(
    ["marimo.lsp.server", "marimo.lsp.path"],
    "Changing the language-server runtime requires reloading the window to take effect.",
  );

  yield* Effect.forkScoped(
    code.workspace.configurationChanges.pipe(
      Stream.filter((event) =>
        event.affectsConfiguration("marimo.notebookFileRoot"),
      ),
      Stream.runForEach(
        Effect.fn(function* (event) {
          for (const { notebookId } of yield* notebooks.getRuntimeSessions) {
            const uri = code.utils.parseUri(notebookId);
            if (
              Result.isSuccess(uri) &&
              event.affectsConfiguration("marimo.notebookFileRoot", uri.success)
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
    code.window.activeNotebookEditorChanges.pipe(
      Stream.runForEach(promptForActiveAffectedSession),
    ),
  );
});

export const ReloadOnConfigChangeLive = Layer.effectDiscard(
  watchForConfigurationChanges(),
);
