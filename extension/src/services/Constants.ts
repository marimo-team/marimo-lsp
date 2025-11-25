import { Effect } from "effect";
import { Config } from "./Config.ts";

export class Constants extends Effect.Service<Constants>()("Constants", {
  dependencies: [Config.Default],
  effect: Effect.gen(function* () {
    const config = yield* Config;
    const useManagedLanguageFeatures =
      yield* config.getManagedLanguageFeaturesEnabled();

    const constants = {
      LanguageId: {
        Python: useManagedLanguageFeatures ? "mo-python" : "python",
        Sql: "sql",
        Markdown: "markdown",
      } as const,
    };

    yield* Effect.logDebug(
      "Managed Language Features: " +
        (useManagedLanguageFeatures ? "Enabled" : "Disabled"),
    ).pipe(Effect.annotateLogs({ constants }));

    return constants;
  }),
}) {}
