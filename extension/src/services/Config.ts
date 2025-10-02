import { Effect, Option } from "effect";
import { VsCode } from "./VsCode.ts";

/**
 * Provides access to the extension configuration settings.
 */
export class Config extends Effect.Service<Config>()("Config", {
  dependencies: [VsCode.Default],
  effect: Effect.gen(function* () {
    const code = yield* VsCode;
    return {
      uv: {
        get enabled() {
          return !code.workspace
            .getConfiguration("marimo")
            .get<boolean>("disableUvIntegration", false);
        },
      },
      lsp: {
        get executable(): Option.Option<{
          command: string;
          args: Array<string>;
        }> {
          return Option.fromNullable(
            code.workspace.getConfiguration("marimo.lsp").get<string[]>("path"),
          ).pipe(
            Option.filter((path) => path.length > 0),
            Option.map(([command, ...args]) => ({
              command,
              args,
            })),
          );
        },
      },
    };
  }).pipe(Effect.annotateLogs("service", "Config")),
}) {}
