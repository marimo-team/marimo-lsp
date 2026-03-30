import { Effect, Either } from "effect";

import { VsCode } from "../platform/VsCode.ts";
import { Links } from "../lib/links.ts";

export const reportIssue = Effect.fn(function* () {
  const code = yield* VsCode;
  const uri = Either.getOrThrow(code.utils.parseUri(Links.issues));
  yield* code.env.openExternal(uri);
});
