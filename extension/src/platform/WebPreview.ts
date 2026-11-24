import { Context, Effect, Layer } from "effect";

import * as VsCode from "./VsCode.ts";

/** Opens web content using the presentation preferred by the current host. */
export interface Interface {
  readonly open: (url: string) => Effect.Effect<void, VsCode.ParseUriError>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/WebPreview",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const code = yield* VsCode.Service;
    const open = Effect.fn("WebPreview.open")(function* (url: string) {
      const uri = yield* Effect.fromResult(code.utils.parseUri(url));
      yield* code.env.openExternal(uri);
    });
    return Service.of({ open });
  }),
);
