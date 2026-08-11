import { Context, Effect, Layer } from "effect";

import { Config } from "../config/Config.ts";

export class Constants extends Context.Service<Constants>()("Constants", {
  make: Effect.gen(function* () {
    const config = yield* Config;
    const useManagedLanguageFeatures =
      yield* config.getManagedLanguageFeaturesEnabled;

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
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Config.layer),
  );
}
