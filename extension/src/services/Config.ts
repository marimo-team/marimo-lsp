import { Effect, Option } from "effect";
import { VsCode } from "./VsCode.ts";

/**
 * Provides access to the extension configuration settings.
 */
export class Config extends Effect.Service<Config>()("Config", {
  effect: Effect.gen(function* () {
    const code = yield* VsCode;
    return {
      uv: {
        get enabled() {
          return Effect.andThen(
            code.workspace.getConfiguration("marimo"),
            (config) => !config.get<boolean>("disableUvIntegration", false),
          );
        },
      },
      lsp: {
        get executable() {
          return Effect.gen(function* () {
            const config = yield* code.workspace.getConfiguration("marimo.lsp");
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
    };
  }).pipe(Effect.annotateLogs("service", "Config")),
}) {}
