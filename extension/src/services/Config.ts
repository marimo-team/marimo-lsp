import { Effect, Option } from "effect";
import { VsCode } from "./VsCode.ts";

/**
 * Provides access to the extension configuration settings.
 */
export class Config extends Effect.Service<Config>()("Config", {
  effect: Effect.gen(function* () {
    const code = yield* Effect.serviceOption(VsCode);

    if (Option.isNone(code)) {
      yield* Effect.logWarning(
        "VsCode API is not available. Using default configuration values.",
      );
      return {
        uv: {
          path: Effect.succeed(Option.none<string>()),
          enabled: Effect.succeed(false),
        },
        lsp: {
          executable: Effect.succeed(Option.none()),
        },
        getManagedLanguageFeaturesEnabled() {
          return Effect.succeed(false);
        },
      };
    }

    return {
      uv: {
        get path() {
          return Effect.map(
            code.value.workspace.getConfiguration("marimo.uv"),
            (config) =>
              Option.fromNullable(config.get<string>("path")).pipe(
                Option.filter((p) => p.length > 0),
              ),
          );
        },
        get enabled() {
          return Effect.andThen(
            code.value.workspace.getConfiguration("marimo"),
            (config) => !config.get<boolean>("disableUvIntegration", false),
          );
        },
      },
      lsp: {
        get executable() {
          return Effect.gen(function* () {
            const config =
              yield* code.value.workspace.getConfiguration("marimo.lsp");
            return Option.fromNullable(config.get<string[]>("path")).pipe(
              Option.filter((path) => path.length > 0),
              Option.map(([command, ...args]) => ({
                command,
                args,
              })),
            );
          });
        },
      },
      getManagedLanguageFeaturesEnabled() {
        return Effect.andThen(
          code.value.workspace.getConfiguration("marimo"),
          (config) =>
            !config.get<boolean>("disableManagedLanguageFeatures", false),
        );
      },
    };
  }),
}) {}
