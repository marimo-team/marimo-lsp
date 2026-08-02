import { Effect } from "effect";

import { VsCode } from "../platform/VsCode.ts";

export const openOutlineView = Effect.fn("command.openOutlineView")(
  function* () {
    const code = yield* VsCode;
    yield* code.commands.executeCommand("outline.focus");
  },
);
