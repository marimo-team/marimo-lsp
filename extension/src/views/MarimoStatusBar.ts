import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { Effect, Either, Layer, Option } from "effect";
import { unreachable } from "../assert.ts";
import { NotebookSerializer } from "../services/NotebookSerializer.ts";
import { ExtensionContext } from "../services/Storage.ts";
import { Telemetry } from "../services/Telemetry.ts";
import { VsCode } from "../services/VsCode.ts";
import { Links } from "../utils/links.ts";
import { StatusBar } from "./StatusBar.ts";

/**
 * Manages the marimo status bar item with quick pick menu.
 */
export const MarimoStatusBarLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const statusBar = yield* StatusBar;

    // Register the command that shows the quick pick menu
    yield* code.commands.registerCommand(
      "marimo.showMarimoMenu",
      Effect.fn(function* () {
        const selection = yield* code.window.showQuickPickItems(
          [
            {
              label: "$(question) View marimo documentation",
              value: "documentation",
            },
            {
              label: "$(bookmark) View tutorials",
              value: "tutorials",
            },
            {
              label: "$(comment-discussion) Join Discord community",
              value: "discord",
            },
            {
              label: "$(bug) Report an issue or suggest a feature",
              value: "reportIssue",
            },
            {
              label: "$(settings) Edit settings",
              value: "settings",
            },
            {
              label: "$(output) Show diagnostics",
              value: "diagnostics",
            },
          ] as const,
          {
            placeHolder: "marimo",
          },
        );

        if (Option.isNone(selection)) {
          return;
        }

        switch (selection.value.value) {
          case "documentation": {
            yield* openUrl(Links.documentation);
            break;
          }
          case "tutorials": {
            yield* tutorialCommands().pipe(
              Effect.catchAll(
                Effect.fnUntraced(function* (error) {
                  yield* Effect.logError("Failed to open tutorial", error);
                  yield* code.window.showErrorMessage(
                    "Failed to open tutorial. See marimo logs for more info.",
                  );
                }),
              ),
            );
            break;
          }
          case "discord": {
            yield* openUrl(Links.discord);
            break;
          }
          case "settings": {
            yield* code.commands.executeCommand(
              "workbench.action.openSettings",
              "marimo",
            );
            break;
          }
          case "reportIssue": {
            yield* openUrl(Links.issues);
            break;
          }
          case "diagnostics": {
            yield* code.commands.executeCommand("marimo.showDiagnostics");
            break;
          }
          default: {
            unreachable(selection.value);
          }
        }
      }),
    );

    // Register the command that opens tutorials directly
    yield* code.commands.registerCommand("marimo.openTutorial", () =>
      tutorialCommands().pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* Effect.logError("Failed to open tutorial", error);
            yield* code.window.showErrorMessage(
              "Failed to open tutorial. See marimo logs for more info.",
            );
          }),
        ),
      ),
    );

    // Create the status bar item
    yield* statusBar.createSimpleStatusBarItem({
      id: "marimo.statusBar",
      text: "$(notebook) marimo",
      // TODO: This could show status info instead (e.g. version, running, etc.)
      tooltip: "Click to view marimo options",
      command: "marimo.showMarimoMenu",
      alignment: "Left",
      priority: 100,
    });

    yield* Effect.logInfo("marimo status bar initialized");
  }),
);

/**
 * Opens a URL in the default browser
 */
const openUrl = Effect.fn(function* (url: `https://${string}`) {
  const code = yield* VsCode;
  return code.env.openExternal(Either.getOrThrow(code.utils.parseUri(url)));
});

const TUTORIALS = [
  // Get started with marimo basics
  ["Intro", "intro.py", "book"],
  // Learn how cells interact with each other
  ["Dataflow", "dataflow.py", "repo-forked"],
  // Create interactive UI components
  ["UI Elements", "ui.py", "layout"],
  // Format text with parameterized markdown
  ["Markdown", "markdown.py", "markdown"],
  // Create interactive visualizations
  ["Plotting", "plots.py", "graph"],
  // Query databases directly in marimo
  ["SQL", "sql.py", "database"],
  // Customize the layout of your cells' output
  ["Layout", "layout.py", "layout-panel-left"],
  // Understand marimo's pure-Python file format
  ["File Format", "fileformat.py", "file"],
  // Transiting from Jupyter to marimo
  ["Coming from Jupyter", "for_jupyter_users.py", "code"],
] as const;

/**
 * Shows tutorial options
 */
const tutorialCommands = Effect.fn(function* () {
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
    {
      placeHolder: "Select a tutorial",
    },
  );

  if (Option.isNone(selection)) {
    return;
  }

  const filename = selection.value.description;
  const tutorialName = selection.value.label;

  // Build path to tutorial file
  const tutorialUri = code.Uri.joinPath(
    context.extensionUri,
    "tutorials",
    filename,
  );

  // Read tutorial file content
  const bytes = yield* code.workspace.fs.readFile(tutorialUri);

  // Try to write to temp file, fall back to untitled if it fails
  const result = yield* Effect.either(
    Effect.gen(function* () {
      // Create temp file path
      const tempDir = NodeOs.tmpdir();
      const tempFilePath = NodePath.join(
        tempDir,
        `marimo_tutorial_${filename}`,
      );
      const tempFileUri = code.Uri.file(tempFilePath);

      // Write tutorial content to temp file
      yield* code.workspace.fs.writeFile(tempFileUri, bytes);

      // Open the temp file as a notebook
      const notebook = yield* code.workspace.openNotebookDocument(tempFileUri);
      yield* code.window.showNotebookDocument(notebook);

      yield* Effect.logInfo("Opened tutorial as temp file").pipe(
        Effect.annotateLogs({
          tutorial: filename,
          path: tempFilePath,
        }),
      );
    }),
  );

  // If temp file approach failed, fall back to untitled
  if (Either.isLeft(result)) {
    yield* Effect.logWarning(
      "Failed to create temp file, opening as untitled",
    ).pipe(
      Effect.annotateLogs({
        tutorial: filename,
        error: result.left,
      }),
    );

    // Deserialize Python file to notebook data
    const notebookData = yield* serializer.deserializeEffect(bytes);

    // Open as untitled notebook
    const notebook = yield* code.workspace.openUntitledNotebookDocument(
      serializer.notebookType,
      notebookData,
    );

    // Show the notebook
    yield* code.window.showNotebookDocument(notebook);

    yield* Effect.logInfo("Opened tutorial as untitled").pipe(
      Effect.annotateLogs({
        tutorial: filename,
      }),
    );
  }

  // Track walkthrough step completion
  yield* telemetry.capture("tutorial_opened", {
    tutorial: tutorialName,
  });
});
