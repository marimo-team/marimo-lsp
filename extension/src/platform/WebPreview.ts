import { Context, Effect, Layer } from "effect";

import { VsCode } from "./VsCode.ts";

/** Opens web content using the presentation preferred by the current host. */
export class WebPreview extends Context.Service<WebPreview>()("WebPreview", {
  make: Effect.gen(function* () {
    const code = yield* VsCode;
    return {
      /** Show web content in the default external browser. */
      open: Effect.fn("WebPreview.open")(function* (url: string) {
        const uri = yield* Effect.fromResult(code.utils.parseUri(url));
        yield* code.env.openExternal(uri);
      }),
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
