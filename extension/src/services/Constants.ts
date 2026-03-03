import { Effect } from "effect";

import { Config } from "./Config.ts";

export class Constants extends Effect.Service<Constants>()("Constants", {
  dependencies: [Config.Default],
  effect: Effect.gen(function* () {
    const config = yield* Config;
    const languageFeaturesMode = yield* config.getLanguageFeaturesMode();

    const constants = {
      LanguageId: {
        Python: languageFeaturesMode === "external" ? "python" : "mo-python",
        Sql: "sql",
        Markdown: "markdown",
      } as const,
    };

    yield* Effect.logDebug(
      `Language Features Mode: ${languageFeaturesMode}`,
    ).pipe(Effect.annotateLogs({ constants }));

    return constants;
  }),
}) {}
