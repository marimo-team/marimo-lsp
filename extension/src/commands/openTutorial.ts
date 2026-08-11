import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { Cause, Effect, Option, Result } from "effect";

import { defineCommand } from "../commands.ts";
import { NotebookSerializer } from "../notebook/NotebookSerializer.ts";
import { ExtensionContext } from "../platform/Storage.ts";
import { VsCode } from "../platform/VsCode.ts";
import { Telemetry } from "../telemetry/Telemetry.ts";
import { MarimoCommands } from "./MarimoCommands.ts";

const TUTORIALS = [
  ["Intro", "intro.py", "book"],
  ["Dataflow", "dataflow.py", "repo-forked"],
  ["UI Elements", "ui.py", "layout"],
  ["Markdown", "markdown.py", "markdown"],
  ["Plotting", "plots.py", "graph"],
  ["SQL", "sql.py", "database"],
  ["Layout", "layout.py", "layout-panel-left"],
  ["File Format", "fileformat.py", "file"],
  ["Coming from Jupyter", "for_jupyter_users.py", "code"],
] as const;

const openTutorial = Effect.fn("command.openTutorial")(function* () {
  const code = yield* VsCode;
  const context = yield* ExtensionContext;
  const serializer = yield* NotebookSerializer;
  const telemetry = yield* Telemetry;
  const selection = yield* code.window.showQuickPickItems(
    TUTORIALS.map(([label, filename, icon]) => ({
      label,
      description: filename,
      iconPath: new code.ThemeIcon(icon),
    })),
    { placeHolder: "Select a tutorial" },
  );
  if (Option.isNone(selection)) return;

  const filename = selection.value.description;
  const tutorialName = selection.value.label;
  const bytes = yield* code.workspace.fs.readFile(
    code.Uri.joinPath(context.extensionUri, "tutorials", filename),
  );
  const result = yield* Effect.result(
    Effect.gen(function* () {
      const tempFilePath = NodePath.join(
        NodeOs.tmpdir(),
        `marimo_tutorial_${filename}`,
      );
      const tempFileUri = code.Uri.file(tempFilePath);
      yield* code.workspace.fs.writeFile(tempFileUri, bytes);
      const notebook = yield* code.workspace.openNotebookDocument(tempFileUri);
      yield* code.window.showNotebookDocument(notebook);
      yield* Effect.logInfo("Opened tutorial as temp file").pipe(
        Effect.annotateLogs({ tutorial: filename, path: tempFilePath }),
      );
    }),
  );

  if (Result.isFailure(result)) {
    yield* Effect.logWarning(
      "Failed to create temp file, opening as untitled",
    ).pipe(Effect.annotateLogs({ tutorial: filename, error: result.failure }));
    const notebookData = yield* serializer.deserializeEffect(bytes);
    const notebook = yield* code.workspace.openUntitledNotebookDocument(
      serializer.notebookType,
      notebookData,
    );
    yield* code.window.showNotebookDocument(notebook);
    yield* Effect.logInfo("Opened tutorial as untitled").pipe(
      Effect.annotateLogs({ tutorial: filename }),
    );
  }
  yield* telemetry.tutorialOpened(tutorialName);
});

const handler = () =>
  openTutorial().pipe(
    Effect.catch(
      Effect.fn(function* (error) {
        const code = yield* VsCode;
        yield* Effect.logError("Failed to open tutorial").pipe(
          Effect.annotateLogs({ cause: Cause.fail(error) }),
        );
        yield* code.window.showErrorMessage(
          "Failed to open tutorial. See marimo logs for more info.",
        );
      }),
    ),
  );

export default defineCommand(MarimoCommands.openTutorial, handler);
