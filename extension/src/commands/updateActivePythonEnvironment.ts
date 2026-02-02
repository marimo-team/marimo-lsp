import { Effect, Either, Option } from "effect";
import { MarimoNotebookDocument } from "../schemas.ts";
import { ControllerRegistry } from "../services/ControllerRegistry.ts";
import { PythonExtension } from "../services/PythonExtension.ts";
import { Uv } from "../services/Uv.ts";
import { VsCode } from "../services/VsCode.ts";
import { getVenvPythonPath } from "../utils/getVenvPythonPath.ts";
import { showErrorAndPromptLogs } from "../utils/showErrorAndPromptLogs.ts";

export const updateActivePythonEnvironment = Effect.fn(function* () {
  const uv = yield* Uv;
  const code = yield* VsCode;
  const py = yield* PythonExtension;
  const controllers = yield* ControllerRegistry;

  const editor = yield* code.window.getActiveNotebookEditor();

  if (Option.isNone(editor)) {
    yield* code.window.showInformationMessage(
      "No marimo notebook is currently open",
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

  const controller = yield* controllers.getActiveController(notebook.value);

  if (Option.isNone(controller)) {
    yield* code.window.showInformationMessage(
      "No active controller for the current marimo notebook found. Please select a kernel first.",
    );
    return;
  }

  let executable: string;
  if (controller.value._tag === "PythonController") {
    executable = controller.value.executable;
  } else {
    const script = editor.value.notebook.uri.fsPath;
    const venvResult = yield* uv.syncScript({ script }).pipe(Effect.either);

    if (Either.isLeft(venvResult)) {
      return yield* showErrorAndPromptLogs(
        "Failed to synchronize virtual environment for the current notebook.",
        { channel: uv.channel },
      );
    }

    executable = getVenvPythonPath(venvResult.right);
  }

  // update the active python environment
  yield* py.updateActiveEnvironmentPath(executable);

  // inform the user
  yield* code.window.showInformationMessage(
    `Active Python environment updated to: ${executable}`,
  );
});
