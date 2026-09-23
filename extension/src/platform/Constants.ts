import { Context, Effect, Layer } from "effect";

import * as Config from "../config/Config.ts";

export interface Interface {
  readonly LanguageId: {
    readonly Python: "mo-python" | "python";
    readonly Sql: "sql";
    readonly Markdown: "markdown";
  };
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/Constants",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service;
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

    return Service.of(constants);
  }),
);

export const defaultLayer = layer.pipe(Layer.provide(Config.layer));
