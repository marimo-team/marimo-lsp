import { Effect, Option, Result } from "effect";

import { defineCommand } from "../commands.ts";
import { NotebookRuntime } from "../kernel/NotebookRuntime.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { VsCode } from "../platform/VsCode.ts";
import { getVenvPythonPath } from "../python/getVenvPythonPath.ts";
import { PythonExtension } from "../python/PythonExtension.ts";
import { Uv } from "../python/Uv.ts";
import type { NotebookTarget } from "./Invocation.ts";
import { MarimoCommands } from "./MarimoCommands.ts";

const handler = Effect.fn("command.updateActivePythonEnvironment")(function* (
  target: Option.Option<NotebookTarget>,
) {
  const uv = yield* Uv;
  const code = yield* VsCode;
  const py = yield* PythonExtension;
  const notebooks = yield* NotebookRuntime;

  if (Option.isNone(target)) {
    yield* code.window.showInformationMessage(
      "No marimo notebook is currently open.",
    );
    return;
  }

  const { document: notebook, editor } = target.value;

  const controller = yield* notebooks.forNotebook(notebook.id).getController;

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
    const script = editor.notebook.uri.fsPath;
    const venvResult = yield* uv.syncScript({ script }).pipe(Effect.result);

    if (Result.isFailure(venvResult)) {
      yield* showErrorAndPromptLogs(
        "Failed to synchronize virtual environment for the current notebook.",
        { channel: uv.channel },
      );
      return;
    }

    executable = getVenvPythonPath(venvResult.success);
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

export default defineCommand(
  MarimoCommands.updateActivePythonEnvironment,
  handler,
);
