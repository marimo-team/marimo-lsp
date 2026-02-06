import { Cause, Effect, flow, Option } from "effect";
import { Telemetry } from "../services/Telemetry.ts";
import { VsCode } from "../services/VsCode.ts";
import { showErrorAndPromptLogs } from "../utils/showErrorAndPromptLogs.ts";

export const newMarimoNotebook = Effect.fn("command.newMarimoNotebook")(
  function* () {
    const code = yield* VsCode;
    const telemetry = yield* Telemetry;

    const uri = yield* code.window.showSaveDialog({
      filters: { Python: ["py"] },
    });

    if (Option.isNone(uri)) {
      return;
    }

    yield* code.workspace.fs.writeFile(
      uri.value,
      new TextEncoder().encode(
        `import marimo

app = marimo.App()

@app.cell
def _():
    return
`.trim(),
      ),
    );

    const notebook = yield* code.workspace.openNotebookDocument(uri.value);
    yield* code.window.showNotebookDocument(notebook);

    yield* Effect.logInfo("Created new marimo notebook").pipe(
      Effect.annotateLogs({ uri: notebook.uri.toString() }),
    );

    yield* telemetry.capture("new_notebook_created");
  },
  flow(
    Effect.catchTag(
      "FileSystemError",
      Effect.fnUntraced(function* (error) {
        yield* Effect.logError("Failed to create notebook").pipe(
          Effect.annotateLogs({ cause: Cause.fail(error) }),
        );
        yield* showErrorAndPromptLogs("Failed to create notebook.");
      }),
    ),
  ),
);
