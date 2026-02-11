/**
 * Python Environment Status Bar for Marimo Notebooks
 *
 * ## Why This Exists
 *
 * Marimo notebooks use a custom language ID (`mo-python`) instead of `python`. This means
 * the Python extension's status bar (which shows the active interpreter) doesn't appear
 * for marimo cells since it only shows for `languageId === "python"`.
 *
 * This module provides a fallback status bar that appears when viewing marimo notebooks,
 * ensuring users always have access to the interpreter picker.
 *
 * ## Visibility Logic
 *
 * The Python extension has a `python.interpreter.infoVisibility` setting:
 * - `"always"`: Python ext always shows → we never show (would duplicate)
 * - `"never"`: User doesn't want status bar → we never show (respect preference)
 * - `"onPythonRelated"` (default): We show when a marimo notebook is active
 *
 * @see https://github.com/microsoft/vscode-python/blob/main/src/client/interpreter/interpreterService.ts
 */

import { Effect, Layer, Option, Stream } from "effect";

import { MarimoNotebookDocument } from "../schemas.ts";
import { PythonExtension } from "../services/PythonExtension.ts";
import { VsCode } from "../services/VsCode.ts";
import { formatPythonStatusBarLabel } from "../utils/formatControllerLabel.ts";
import { StatusBar, type StatusBarItem } from "./StatusBar.ts";

/**
 * Based on https://github.com/microsoft/vscode-python/issues/18040#issuecomment-992567670.
 * This is to ensure the item appears right after the Python language status item.
 */
const STATUS_BAR_ITEM_PRIORITY = 100.09999;

/**
 * Manages the Python environment status bar item.
 * Displays the active Python interpreter and allows users to select a different one.
 *
 * Implementation closely follows:
 * https://github.com/microsoft/vscode-python/blob/main/src/client/interpreter/display/index.ts
 */
export const PythonEnvironmentStatusBarLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const statusBar = yield* StatusBar;
    const pythonExtension = yield* PythonExtension;

    const item = yield* statusBar.createStatusBarItem(
      "marimo.pythonEnvironment",
      "Right",
      STATUS_BAR_ITEM_PRIORITY,
    );
    yield* item.setCommand("python.setInterpreter");

    const visibilityTriggers = Stream.mergeAll<void, never, never>(
      [
        code.window.activeNotebookEditorChanges(),
        code.window.activeTextEditorChanges(),
        code.workspace
          .configurationChanges()
          .pipe(
            Stream.filter((e) =>
              e.affectsConfiguration("python.interpreter.infoVisibility"),
            ),
          ),
      ],
      { concurrency: "unbounded" },
    );

    // Update visibility when relevant events occur
    yield* visibilityTriggers.pipe(
      Stream.runForEach(() => updateVisibility(item)),
      Effect.forkScoped,
    );

    // Listen for environment changes and update the status bar
    yield* pythonExtension.activeEnvironmentPathChanges().pipe(
      Stream.runForEach(
        Effect.fnUntraced(function* (event) {
          yield* updateDisplay(item, Option.some(event.path));
          yield* updateVisibility(item);
        }),
      ),
      Effect.forkScoped,
    );

    // Initialize with the current active environment
    const initialEnv = yield* pythonExtension.getActiveEnvironmentPath();
    yield* updateDisplay(item, Option.some(initialEnv.path));
    yield* updateVisibility(item);

    yield* Effect.logInfo("Python environment status bar initialized");
  }),
);

/**
 * Updates the status bar display based on the active Python interpreter.
 * Follows the same logic as the Python extension's updateDisplay method.
 */
const updateDisplay = Effect.fn(function* (
  item: StatusBarItem,
  environmentPath: Option.Option<string>,
) {
  const code = yield* VsCode;
  const pythonExtension = yield* PythonExtension;

  if (Option.isNone(environmentPath)) {
    // No interpreter selected - show warning state
    yield* item.setText("$(alert) Select Python Interpreter");
    yield* item.setTooltip("");
    yield* item.setColor("");
    yield* item.setBackgroundColor("statusBarItem.warningBackground");
    return;
  }

  // Resolve the environment to get details
  const env = yield* pythonExtension.resolveEnvironment(environmentPath.value);

  if (Option.isNone(env)) {
    // Couldn't resolve - show the path
    const pathParts = environmentPath.value.split(/[/\\]/);
    const shortName = pathParts[pathParts.length - 1] || environmentPath.value;
    yield* item.setText(shortName);
    yield* item.setTooltip(environmentPath.value);
    yield* item.setColor("");
    yield* item.setBackgroundColor("statusBarItem.warningBackground");
    return;
  }

  yield* Effect.logInfo(`Python interpreter path: ${env.value.path}`);
  yield* item.setText(formatPythonStatusBarLabel(code, env.value));
  yield* item.setTooltip(env.value.path);
  yield* item.setColor("");
  yield* item.setBackgroundColor(undefined);
});

/**
 * Determines if the status bar should be shown.
 */
const updateVisibility = Effect.fn(function* (item: StatusBarItem) {
  const code = yield* VsCode;

  const config = yield* code.workspace.getConfiguration("python");
  const visibility = config.get<string>("interpreter.infoVisibility");

  // Respect user's explicit preference for Python extension's status bar
  if (visibility === "always" || visibility === "never") {
    yield* item.hide();
    return;
  }

  // "onPythonRelated" (default): show when a marimo notebook is active
  const marimoNotebook = Option.flatMap(
    yield* code.window.getActiveNotebookEditor(),
    (editor) => MarimoNotebookDocument.tryFrom(editor.notebook),
  );

  if (Option.isSome(marimoNotebook)) {
    yield* item.show();
    return;
  }

  yield* item.hide();
});
