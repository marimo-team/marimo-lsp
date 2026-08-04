import { Effect } from "effect";

import { defineCommand } from "../commands.ts";
import { VsCode } from "../platform/VsCode.ts";
import { MarimoCommands } from "./MarimoCommands.ts";

const handler = Effect.fn("command.openOutlineView")(function* () {
  const code = yield* VsCode;
  yield* code.commands.executeVSCode("outline.focus");
});

export default defineCommand(MarimoCommands.openOutlineView, handler);
