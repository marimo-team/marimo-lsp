import { Effect, Layer, Option, Result, Stream } from "effect";

import restartKernel from "../commands/restartKernel.ts";
import * as NotebookRuntime from "../kernel/NotebookRuntime.ts";
import * as VsCode from "../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";

export const promptForFileRootChange = Effect.gen(function* () {
  const code = yield* VsCode.Service;

  const restart = yield* code.window.showInformationMessage(
    "The notebook file root changed. Restart the marimo kernel to apply it.",
    { items: ["Restart Kernel"] },
  );
  if (Option.isSome(restart) && restart.value === "Restart Kernel") {
    yield* code.commands.execute(restartKernel.command);
  }
}).pipe(Effect.withSpan("ReloadOnConfigChange.promptForFileRootChange"));

/** Watches configuration changes that require an explicit reload or restart. */
export const watch = Effect.gen(function* () {
  const code = yield* VsCode.Service;
  const notebooks = yield* NotebookRuntime.Service;
  const pendingFileRootChanges = new Set<string>();

  const watchForWindowReload = Effect.fn(
    "ReloadOnConfigChange.watchForWindowReload",
  )(function* (sections: readonly string[], message: string) {
    const prompt = Effect.gen(function* () {
      const reload = yield* code.window.showInformationMessage(message, {
        items: ["Reload Window"],
      });
      if (Option.isSome(reload) && reload.value === "Reload Window") {
        yield* code.commands.executeVSCode("workbench.action.reloadWindow");
      }
    }).pipe(Effect.withSpan("ReloadOnConfigChange.promptForWindowReload"));

    yield* Effect.forkScoped(
      code.workspace.configurationChanges.pipe(
        Stream.filter((event) =>
          sections.some((section) => event.affectsConfiguration(section)),
        ),
        Stream.runForEach(() => prompt),
      ),
    );
  });

  const promptForActiveAffectedSession = Effect.gen(function* () {
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
    yield* promptForFileRootChange;
  }).pipe(
    Effect.withSpan("ReloadOnConfigChange.promptForActiveAffectedSession"),
  );

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
          yield* promptForActiveAffectedSession;
        }),
      ),
    ),
  );

  yield* Effect.forkScoped(
    code.window.activeNotebookEditorChanges.pipe(
      Stream.runForEach(() => promptForActiveAffectedSession),
    ),
  );
}).pipe(Effect.withSpan("ReloadOnConfigChange.watch"));

export const layer = Layer.effectDiscard(watch);
