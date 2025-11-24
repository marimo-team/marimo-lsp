/**
 * Python Environment Status Bar for Marimo Notebooks
 *
 * ## Why This Exists
 *
 * In "managed" mode, marimo notebooks use a custom language ID (`mo-python`) instead of
 * the standard `python` language ID. This is done to disable certain language server features
 * and editor behaviors that could conflict with marimo's managed execution model.
 *
 * However, this has a side effect: the Python extension's status bar item (which shows the
 * active Python interpreter and allows users to select a different one) only appears for
 * files with the `python` language ID. Since our notebook cells use `mo-python`, users lose
 * the ability to select their Python environment through the familiar status bar picker.
 *
 * ## What This Does
 *
 * This module creates a duplicate status bar item that:
 * - Displays the active Python environment (e.g., "3.13.5 (myenv)")
 * - Opens the Python extension's interpreter picker when clicked
 * - Only appears when marimo notebooks are visible AND no regular Python files or Jupyter
 *   notebooks are open (to avoid duplicate status bars)
 * - Follows the same visual style and behavior as the Python extension's status bar
 *
 * ## Implementation
 *
 * The implementation closely follows the Python extension's own status bar:
 * {@link https://github.com/microsoft/vscode-python/blob/main/src/client/interpreter/display/index.ts}
 *
 * It's a bit of a hack, but it maintains UI consistency and ensures users always have access
 * to the interpreter picker when working with marimo notebooks.
 */

import { Effect, Layer, Option, Stream } from "effect";
import { NOTEBOOK_TYPE } from "../constants.ts";
import { PythonExtension } from "../services/PythonExtension.ts";
import { VsCode } from "../services/VsCode.ts";
import { formatPythonStatusBarLabel } from "../utils/formatControllerLabel.ts";
import { StatusBar } from "./StatusBar.ts";

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
    const statusBar = yield* StatusBar;
    const code = yield* VsCode;
    const pythonExtension = yield* PythonExtension;

    // Track current state to avoid unnecessary updates
    let currentlySelectedInterpreterDisplay: string | undefined;
    let currentlySelectedInterpreterPath: string | undefined;
    let statusBarCanBeDisplayed = false;
    let shouldShowStatusBar = false;

    // Create the status bar item at the same position as Python extension
    const item = yield* statusBar.createStatusBarItem(
      "marimo.pythonEnvironment",
      "Right",
      STATUS_BAR_ITEM_PRIORITY,
    );

    // Set up the command to trigger Python interpreter selection
    yield* item.setCommand("python.setInterpreter");

    /**
     * Updates the status bar display based on the active Python interpreter.
     * Follows the same logic as the Python extension's updateDisplay method.
     */
    const updateDisplay = (environmentPath: string | undefined) =>
      Effect.gen(function* () {
        if (!environmentPath) {
          // No interpreter selected - show warning state
          yield* item.setText("$(alert) Select Python Interpreter");
          yield* item.setTooltip("");
          yield* item.setColor("");
          yield* item.setBackgroundColor("statusBarItem.warningBackground");
          currentlySelectedInterpreterDisplay = undefined;
          currentlySelectedInterpreterPath = undefined;
          statusBarCanBeDisplayed = true;
          yield* updateVisibility();
          return;
        }

        // Resolve the environment to get details
        const env = yield* pythonExtension.resolveEnvironment(environmentPath);

        if (Option.isNone(env)) {
          // Couldn't resolve - show the path
          const pathParts = environmentPath.split(/[/\\]/);
          const shortName = pathParts[pathParts.length - 1] || environmentPath;
          yield* item.setText(shortName);
          yield* item.setTooltip(environmentPath);
          yield* item.setColor("");
          yield* item.setBackgroundColor("statusBarItem.warningBackground");
          currentlySelectedInterpreterDisplay = undefined;
          currentlySelectedInterpreterPath = environmentPath;
          statusBarCanBeDisplayed = true;
          yield* updateVisibility();
          return;
        }

        // Check if we need to update (avoid redundant updates)
        const displayName = formatPythonStatusBarLabel(code, env.value);
        const envPath = env.value.path;
        if (
          currentlySelectedInterpreterDisplay === displayName &&
          currentlySelectedInterpreterPath === envPath
        ) {
          return;
        }

        // Log the interpreter path change
        if (currentlySelectedInterpreterPath !== envPath) {
          yield* Effect.logInfo(`Python interpreter path: ${envPath}`);
          currentlySelectedInterpreterPath = envPath;
        }

        // Update the status bar with interpreter info
        yield* item.setText(displayName);
        yield* item.setTooltip(envPath);
        yield* item.setColor("");
        // Clear background color by setting to undefined
        yield* Effect.sync(() => {
          item.raw.backgroundColor = undefined;
        });

        currentlySelectedInterpreterDisplay = displayName;
        statusBarCanBeDisplayed = true;
        yield* updateVisibility();
      });

    /**
     * Controls the visibility of the status bar item.
     * Only shows when:
     * 1. statusBarCanBeDisplayed is true (interpreter info is ready)
     * 2. shouldShowStatusBar is true (marimo notebook visible AND no Python file open)
     */
    const updateVisibility = () =>
      Effect.gen(function* () {
        if (!statusBarCanBeDisplayed || !shouldShowStatusBar) {
          yield* item.hide();
          return;
        }
        yield* item.show();
      });

    /**
     * Determines if the status bar should be shown.
     * Shows when:
     * - At least one marimo notebook is visible
     * - AND no regular Python files are open
     * - AND no regular Jupyter notebooks are open
     */
    const checkShouldShowStatusBar = () =>
      Effect.gen(function* () {
        const visibleNotebookEditors =
          yield* code.window.getVisibleNotebookEditors();
        const visibleTextEditors = yield* code.window.getVisibleTextEditors();

        // Check if any marimo notebook is visible
        const hasMarimoNotebook = visibleNotebookEditors.some(
          (editor) => editor.notebook.notebookType === NOTEBOOK_TYPE,
        );

        // Check if any regular Python file is open
        const hasPythonFile = visibleTextEditors.some(
          (editor: { document: { languageId: string } }) =>
            editor.document.languageId === "python",
        );

        // Check if any regular Jupyter notebook is open
        const hasJupyterNotebook = visibleNotebookEditors.some(
          (editor) =>
            editor.notebook.notebookType === "jupyter-notebook" ||
            editor.notebook.notebookType === "interactive",
        );

        const newShouldShow =
          hasMarimoNotebook && !hasPythonFile && !hasJupyterNotebook;
        if (shouldShowStatusBar !== newShouldShow) {
          shouldShowStatusBar = newShouldShow;
          return true; // Changed
        }
        return false; // No change
      });

    // Listen for visible notebook editor changes
    yield* code.window.visibleNotebookEditorsChanges().pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const changed = yield* checkShouldShowStatusBar();
          if (changed) {
            yield* updateVisibility();
          }
        }),
      ),
      Effect.forkScoped,
    );

    // Listen for visible text editor changes
    yield* code.window.visibleTextEditorsChanges().pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const changed = yield* checkShouldShowStatusBar();
          if (changed) {
            yield* updateVisibility();
          }
        }),
      ),
      Effect.forkScoped,
    );

    // Check initial state
    yield* checkShouldShowStatusBar();

    // Get and display the initial active environment
    const initialEnv = yield* pythonExtension.getActiveEnvironmentPath();
    yield* updateDisplay(initialEnv?.path).pipe(
      Effect.catchAll((error) =>
        Effect.logWarning("Failed to initialize Python status bar", { error }),
      ),
    );

    // Listen for environment changes and update the status bar
    yield* pythonExtension.activeEnvironmentPathChanges().pipe(
      Stream.runForEach((event) =>
        updateDisplay(event.path).pipe(
          Effect.catchAll((error) =>
            Effect.logWarning("Failed to update Python status bar", {
              error,
            }),
          ),
        ),
      ),
      Effect.forkScoped,
    );

    yield* Effect.logInfo("Python environment status bar initialized");
  }),
);
