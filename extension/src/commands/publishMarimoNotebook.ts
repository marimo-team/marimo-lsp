import { Effect, Option } from "effect";
import { VsCode } from "../services/VsCode.ts";

export const publishMarimoNotebook = Effect.fn(function* () {
  const code = yield* VsCode;
  const choice = yield* code.window.showQuickPickItems([
    {
      label: "GitHub Gist",
      detail: "Publish marimo notebook as a GitHub Gist",
    },
  ]);
  if (Option.isNone(choice)) {
    return choice;
  }
  if (choice.value.label === "GitHub Gist") {
    yield* code.commands.executeCommand("marimo.publishMarimoNotebookGist");
  }
});
