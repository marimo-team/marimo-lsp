import { Effect } from "effect";
import { VsCode } from "./VsCode.ts";

/**
 * Provides access to the extension configuration settings.
 */
export class Config extends Effect.Service<Config>()("Config", {
  dependencies: [VsCode.Default],
  effect: Effect.gen(function* () {
    const code = yield* VsCode;
    return {
      get lsp() {
        return {
          get executable(): undefined | { command: string; args: string[] } {
            const lspPath = code.workspace
              .getConfiguration("marimo.lsp")
              .get<string[]>("path", []);
            if (!lspPath || lspPath.length === 0) {
              return undefined;
            }
            const [command, ...args] = lspPath;
            return { command, args };
          },
        };
      },
    };
  }),
}) {}
