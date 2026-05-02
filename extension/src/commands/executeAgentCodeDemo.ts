import { Effect, Option } from "effect";

import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";
import { executeAgentCode } from "./executeAgentCode.ts";

/**
 * Palette-visible wrapper around `marimo.executeAgentCode`. Prompts for
 * a Python snippet and runs it against the currently-focused marimo
 * notebook's kernel scratchpad. Exists so end-users can smoke-test the
 * agent surface without an external bridge — once a bridge ships, this
 * command can be removed.
 */
export const executeAgentCodeDemo = Effect.fn("command.executeAgentCodeDemo")(
  function* () {
    const vs = yield* VsCode;
    const editor = yield* vs.window.getActiveNotebookEditor();
    if (Option.isNone(editor)) {
      yield* vs.window.showInformationMessage(
        "Open a marimo notebook first.",
      );
      return;
    }
    const notebook = MarimoNotebookDocument.tryFrom(editor.value.notebook);
    if (Option.isNone(notebook)) {
      yield* vs.window.showInformationMessage(
        "Active notebook isn't a marimo notebook.",
      );
      return;
    }

    const input = yield* vs.window.showInputBox({
      prompt: "Python code to run in the notebook's kernel scratchpad",
      placeHolder: "print(2 + 2)",
      value: "print(2 + 2)",
    });
    if (Option.isNone(input)) return;

    const result = yield* executeAgentCode({
      notebookUri: notebook.value.id,
      code: input.value,
    });

    yield* vs.window.showInformationMessage(
      `executeAgentCode → stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)} error=${JSON.stringify(result.error)}`,
    );
  },
  Effect.tapErrorCause(Effect.logError),
  Effect.catchAllCause(() =>
    showErrorAndPromptLogs("marimo.executeAgentCodeDemo failed."),
  ),
);
