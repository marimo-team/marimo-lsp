import { Effect, Either, Option } from "effect";

import type { NotebookToolbarContext } from "../commands.ts";
import { NotebookRuntime } from "../kernel/NotebookRuntime.ts";
import { getNotebookCommandEditor } from "../lib/getNotebookCommandEditor.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { VsCode } from "../platform/VsCode.ts";
import { getVenvPythonPath } from "../python/getVenvPythonPath.ts";
import { PythonExtension } from "../python/PythonExtension.ts";
import { Uv } from "../python/Uv.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";

export const updateActivePythonEnvironment = Effect.fn(
  "command.updateActivePythonEnvironment",
)(function* (context?: NotebookToolbarContext) {
  const uv = yield* Uv;
  const code = yield* VsCode;
  const py = yield* PythonExtension;
  const notebooks = yield* NotebookRuntime;

  const editor = yield* getNotebookCommandEditor(context);

  if (Option.isNone(editor)) {
    yield* code.window.showInformationMessage(
      "No marimo notebook is currently open.",
    );
    return;
  }

  const notebook = MarimoNotebookDocument.tryFrom(editor.value.notebook);

  if (Option.isNone(notebook)) {
    yield* code.window.showInformationMessage(
      "Active notebook is not a marimo notebook.",
    );
    return;
  }

  const controller = yield* notebooks
    .forNotebook(notebook.value.id)
    .getController();

  if (Option.isNone(controller)) {
    yield* code.window.showInformationMessage(
      "No active controller for the current marimo notebook found. Please select a kernel first.",
    );
    return;
  }

  let executable: string;
  if (typeof controller.value.executable === "string") {
    executable = controller.value.executable;
  } else {
    const script = editor.value.notebook.uri.fsPath;
    const venvResult = yield* uv.syncScript({ script }).pipe(Effect.either);

    if (Either.isLeft(venvResult)) {
      yield* showErrorAndPromptLogs(
        "Failed to synchronize virtual environment for the current notebook.",
        { channel: uv.channel },
      );
      return;
    }

    executable = getVenvPythonPath(venvResult.right);
  }

  // update the active python environment
  yield* py.updateActiveEnvironmentPath(executable);

  // inform the user
  yield* code.window.showInformationMessage(
    `Active Python environment updated to: ${executable}`,
  );

  yield* Effect.logInfo("Updated active Python environment").pipe(
    Effect.annotateLogs({ executable }),
  );
});
