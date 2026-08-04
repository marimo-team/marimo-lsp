import { Effect } from "effect";

import { defineMarimoCommand } from "../commands.ts";
import { VsCode } from "../platform/VsCode.ts";
import { GeneratedMarimoCommands } from "./MarimoCommands.gen.ts";

const openOutlineView = Effect.fn("command.openOutlineView")(function* () {
  const code = yield* VsCode;
  yield* code.commands.executeVSCode("outline.focus");
});

export const openOutlineViewCommand = defineMarimoCommand(
  GeneratedMarimoCommands.openOutlineView,
  openOutlineView,
);
