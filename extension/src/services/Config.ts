import { Effect, Option } from "effect";

import { VsCode } from "./VsCode.ts";

export type LanguageFeaturesMode = "managed" | "external" | "none";

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
        getLanguageFeaturesMode() {
          return Effect.succeed("none" as LanguageFeaturesMode);
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
      getLanguageFeaturesMode() {
        return Effect.andThen(
          code.value.workspace.getConfiguration("marimo"),
          (config): LanguageFeaturesMode => {
            // If the new setting was explicitly set, use it
            const inspected =
              config.inspect<LanguageFeaturesMode>("languageFeatures");
            if (
              inspected?.workspaceFolderValue !== undefined ||
              inspected?.workspaceValue !== undefined ||
              inspected?.globalValue !== undefined
            ) {
              return config.get<LanguageFeaturesMode>(
                "languageFeatures",
                "managed",
              );
            }

            // Fall back to deprecated boolean
            const inspectedOld = config.inspect<boolean>(
              "disableManagedLanguageFeatures",
            );
            if (
              inspectedOld?.workspaceFolderValue !== undefined ||
              inspectedOld?.workspaceValue !== undefined ||
              inspectedOld?.globalValue !== undefined
            ) {
              const disabled = config.get<boolean>(
                "disableManagedLanguageFeatures",
                false,
              );
              return disabled ? "external" : "managed";
            }

            // Neither setting explicitly set — default to "none"
            return "none";
          },
        );
      },
    };
  }),
}) {}
