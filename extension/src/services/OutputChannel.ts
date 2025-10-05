import { Effect } from "effect";

import { VsCode } from "./VsCode.ts";

export class OutputChannel extends Effect.Service<OutputChannel>()(
  "OutputChannel",
  {
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      return yield* code.window.createOutputChannel("marimo");
    }),
  },
) {}
