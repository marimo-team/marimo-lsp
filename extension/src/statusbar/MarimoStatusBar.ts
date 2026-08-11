import { Effect, Layer } from "effect";

import { commandId } from "../commands.ts";
import openTutorial from "../commands/openTutorial.ts";
import showMarimoMenu from "../commands/showMarimoMenu.ts";
import { VsCode } from "../platform/VsCode.ts";
import { StatusBar } from "./StatusBar.ts";

/** Manages the marimo status bar item with quick pick menu. */
export const MarimoStatusBarLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const statusBar = yield* StatusBar;

    yield* code.commands.register(showMarimoMenu);
    yield* code.commands.register(openTutorial);
    yield* statusBar.createSimpleStatusBarItem({
      id: "marimo.statusBar",
      text: "$(notebook) marimo",
      tooltip: "Click to view marimo options",
      command: commandId(showMarimoMenu.command),
      alignment: "Left",
      priority: 100,
    });

    yield* Effect.logDebug("marimo status bar initialized");
  }),
);
