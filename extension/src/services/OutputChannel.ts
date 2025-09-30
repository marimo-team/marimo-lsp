import { Effect } from "effect";

import { Window as VsCodeWindow } from "./VsCode.ts";

export class OutputChannel extends Effect.Service<OutputChannel>()(
  "OutputChannel",
  {
    dependencies: [VsCodeWindow.Default],
    scoped: Effect.gen(function* () {
      const win = yield* VsCodeWindow;
      return yield* win.createOutputChannel("marimo");
    }),
  },
) {}
