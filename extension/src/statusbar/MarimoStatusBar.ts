import { Effect, Layer } from "effect";

import { commandId } from "../commands.ts";
import { openTutorialCommand } from "../commands/openTutorial.ts";
import { showMarimoMenuCommand } from "../commands/showMarimoMenu.ts";
import { VsCode } from "../platform/VsCode.ts";
import { StatusBar } from "./StatusBar.ts";

/** Manages the marimo status bar item with quick pick menu. */
export const MarimoStatusBarLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const statusBar = yield* StatusBar;

    yield* code.commands.register(showMarimoMenuCommand);
    yield* code.commands.register(openTutorialCommand);
    yield* statusBar.createSimpleStatusBarItem({
      id: "marimo.statusBar",
      text: "$(notebook) marimo",
      tooltip: "Click to view marimo options",
      command: commandId(showMarimoMenuCommand),
      alignment: "Left",
      priority: 100,
    });

    yield* Effect.logDebug("marimo status bar initialized");
  }),
);
