import { Effect, Result } from "effect";

import * as VsCode from "../platform/VsCode.ts";

export const openExternalUrl = Effect.fn(function* (url: `https://${string}`) {
  const code = yield* VsCode.Service;
  const uri = Result.getOrThrow(code.utils.parseUri(url));
  return yield* code.env.openExternal(uri);
});
