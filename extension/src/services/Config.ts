import { Effect, Option } from "effect";
import { VsCode } from "./VsCode.ts";

/** Default `uv` binary name */
export const DEFAULT_UV_BINARY = "uv";

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
          enabled: Effect.succeed(false),
          binary: Effect.succeed(DEFAULT_UV_BINARY),
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
        get enabled() {
          return Effect.andThen(
            code.value.workspace.getConfiguration("marimo"),
            (config) => !config.get<boolean>("disableUvIntegration", false),
          );
        },
        get binary() {
          return Effect.andThen(
            code.value.workspace.getConfiguration("marimo.uv"),
            (config) =>
              Option.fromNullable(config.get<string>("path")).pipe(
                Option.filter((p) => p.length > 0),
                Option.getOrElse(() => DEFAULT_UV_BINARY),
              ),
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
