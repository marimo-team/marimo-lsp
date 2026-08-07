import { Effect } from "effect";

import { VsCode } from "./VsCode.ts";

/** Opens web content using the presentation preferred by the current host. */
export class WebPreview extends Effect.Service<WebPreview>()("WebPreview", {
  effect: Effect.gen(function* () {
    const code = yield* VsCode;
    return {
      /** Show web content in the default external browser. */
      open: Effect.fn("WebPreview.open")(function* (url: string) {
        const uri = yield* code.utils.parseUri(url);
        yield* code.env.openExternal(uri);
      }),
    };
  }),
}) {}
