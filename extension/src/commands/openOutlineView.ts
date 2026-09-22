import { Effect } from "effect";

import { defineCommand } from "../commands.ts";
import * as VsCode from "../platform/VsCode.ts";
import { MarimoCommands } from "./MarimoCommands.ts";

const handler = Effect.fn("command.openOutlineView")(function* () {
  const code = yield* VsCode.Service;
  yield* code.commands.executeVSCode("outline.focus");
});

export default defineCommand(MarimoCommands.openOutlineView, handler);
