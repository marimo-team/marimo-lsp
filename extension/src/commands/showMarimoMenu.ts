import { Effect, Option } from "effect";

import { unreachable } from "../assert.ts";
import { defineMarimoCommand } from "../commands.ts";
import { Links } from "../lib/links.ts";
import { openExternalUrl } from "../lib/openExternalUrl.ts";
import { VsCode } from "../platform/VsCode.ts";
import { GeneratedMarimoCommands } from "./MarimoCommands.gen.ts";
import { openTutorialCommand } from "./openTutorial.ts";
import { showDiagnosticsCommand } from "./showDiagnostics.ts";

export const showMarimoMenuCommand = defineMarimoCommand(
  GeneratedMarimoCommands.showMarimoMenu,
  Effect.fn("command.showMarimoMenu")(function* () {
    const code = yield* VsCode;
    const selection = yield* code.window.showQuickPickItems(
      [
        {
          label: "$(question) View marimo documentation",
          value: "documentation",
        },
        { label: "$(bookmark) View tutorials", value: "tutorials" },
        {
          label: "$(comment-discussion) Join Discord community",
          value: "discord",
        },
        {
          label: "$(bug) Report an issue or suggest a feature",
          value: "reportIssue",
        },
        { label: "$(settings) Edit settings", value: "settings" },
        { label: "$(output) Show diagnostics", value: "diagnostics" },
      ] as const,
      { placeHolder: "marimo" },
    );
    if (Option.isNone(selection)) return;

    switch (selection.value.value) {
      case "documentation":
        yield* openExternalUrl(Links.documentation);
        break;
      case "tutorials":
        yield* code.commands.execute(openTutorialCommand);
        break;
      case "discord":
        yield* openExternalUrl(Links.discord);
        break;
      case "settings":
        yield* code.commands.executeVSCode(
          "workbench.action.openSettings",
          "marimo",
        );
        break;
      case "reportIssue":
        yield* openExternalUrl(Links.issues);
        break;
      case "diagnostics":
        yield* code.commands.execute(showDiagnosticsCommand);
        break;
      default:
        unreachable(selection.value);
    }
  }),
);
