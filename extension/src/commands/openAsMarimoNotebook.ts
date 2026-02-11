import { Effect, Option } from "effect";

import { NOTEBOOK_TYPE } from "../constants.ts";
import { VsCode } from "../services/VsCode.ts";

export const openAsMarimoNotebook = Effect.fn("command.openAsMarimoNotebook")(
  function* () {
    const code = yield* VsCode;
    const editor = yield* code.window.getActiveTextEditor();

    if (Option.isNone(editor)) {
      yield* code.window.showInformationMessage(
        "No active file to open as notebook",
      );
      return;
    }

    const uri = editor.value.document.uri;

    // We open first before closing to handle multi-window scenarios correctly:
    // if we close first and it's the only editor in the window, the window
    // closes before we can open the notebook in it.
    yield* code.commands.executeCommand("vscode.openWith", uri, NOTEBOOK_TYPE);

    // Find and close the original text editor tab (not the notebook we just opened).
    // We find the tab after opening the notebook because tab references can become
    // stale when VS Code reorganizes tabs.
    yield* code.window.closeTextEditorTab(uri);

    yield* Effect.logInfo("Opened Python file as marimo notebook").pipe(
      Effect.annotateLogs({ uri: uri.toString() }),
    );
  },
);
