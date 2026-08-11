import { Effect, Result } from "effect";

import { VsCode } from "../platform/VsCode.ts";

export const openExternalUrl = Effect.fn(function* (url: `https://${string}`) {
  const code = yield* VsCode;
  const uri = Result.getOrThrow(code.utils.parseUri(url));
  return yield* code.env.openExternal(uri);
});
