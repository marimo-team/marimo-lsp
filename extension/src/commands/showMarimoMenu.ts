import { Effect, Option } from "effect";

import { unreachable } from "../assert.ts";
import { defineCommand } from "../commands.ts";
import { Links } from "../lib/links.ts";
import { openExternalUrl } from "../lib/openExternalUrl.ts";
import { VsCode } from "../platform/VsCode.ts";
import { WebPreview } from "../platform/WebPreview.ts";
import { MarimoCommands } from "./MarimoCommands.ts";
import openTutorial from "./openTutorial.ts";
import showDiagnostics from "./showDiagnostics.ts";

const handler = Effect.fn("command.showMarimoMenu")(function* () {
  const code = yield* VsCode;
  const webPreview = yield* WebPreview;
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
      yield* webPreview.open(Links.documentation);
      break;
    case "tutorials":
      yield* code.commands.execute(openTutorial.command);
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
      yield* code.commands.execute(showDiagnostics.command);
      break;
    default:
      unreachable(selection.value);
  }
});

export default defineCommand(MarimoCommands.showMarimoMenu, handler);
