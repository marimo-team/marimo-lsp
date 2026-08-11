import { Context, Effect, Layer } from "effect";

import { VsCode } from "./VsCode.ts";

export class OutputChannel extends Context.Service<OutputChannel>()(
  "OutputChannel",
  {
    make: Effect.gen(function* () {
      const code = yield* VsCode;
      return yield* code.window.createLogOutputChannel("marimo");
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
