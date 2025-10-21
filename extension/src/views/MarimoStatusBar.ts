import { Effect, Either, Layer, Option } from "effect";
import { unreachable } from "../assert.ts";
import { VsCode } from "../services/VsCode.ts";
import { Links } from "../utils/links.ts";
import { StatusBar } from "./StatusBar.ts";

/**
 * Manages the marimo status bar item with quick pick menu.
 */
export const MarimoStatusBarLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const statusBar = yield* StatusBar;
    const code = yield* VsCode;

    // Register the command that shows the quick pick menu
    yield* code.commands.registerCommand(
      "marimo.showMarimoMenu",
      Effect.gen(function* () {
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
            yield* openUrl(code, Links.documentation);
            break;
          }
          case "tutorials": {
            yield* tutorialCommands(code);
            break;
          }
          case "discord": {
            yield* openUrl(code, Links.discord);
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
            yield* openUrl(code, Links.issues);
            break;
          }
          default: {
            unreachable(selection.value);
          }
        }
      }),
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
function openUrl(code: VsCode, url: `https://${string}`) {
  return code.env.openExternal(Either.getOrThrow(code.utils.parseUri(url)));
}

// TODO: Open in local vscode instead of external browser
const TUTORIALS = [
  // Get started with marimo basics
  ["Intro", "https://links.marimo.app/tutorial-intro", "book"],
  // Learn how cells interact with each other
  ["Dataflow", "https://links.marimo.app/tutorial-dataflow", "repo-forked"],
  // Create interactive UI components
  ["UI Elements", "https://links.marimo.app/tutorial-ui", "layout"],
  // Format text with parameterized markdown
  ["Markdown", "https://links.marimo.app/tutorial-markdown", "markdown"],
  // Create interactive visualizations
  ["Plotting", "https://links.marimo.app/tutorial-plotting", "graph"],
  // Query databases directly in marimo
  ["SQL", "https://links.marimo.app/tutorial-sql", "database"],
  // Customize the layout of your cells' output
  ["Layout", "https://links.marimo.app/tutorial-layout", "layout-panel-left"],
  // Understand marimo's pure-Python file format
  ["File Format", "https://links.marimo.app/tutorial-fileformat", "file"],
  // Transiting from Jupyter to marimo
  ["Coming from Jupyter", "https://links.marimo.app/tutorial-jupyter", "code"],
] as const;

/**
 * Shows tutorial options
 */
function tutorialCommands(code: VsCode) {
  return Effect.gen(function* () {
    const selection = yield* code.window.showQuickPickItems(
      TUTORIALS.map(([label, url, icon]) => ({
        label,
        description: url,
        iconPath: new code.ThemeIcon(icon),
      })),
      {
        placeHolder: "Select a tutorial",
      },
    );

    if (Option.isNone(selection)) {
      return;
    }

    yield* openUrl(code, selection.value.description);
  });
}
