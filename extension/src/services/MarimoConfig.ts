import { Effect } from "effect";
import * as vscode from "vscode";

export class MarimoConfig extends Effect.Service<MarimoConfig>()(
  "MarimoConfig",
  {
    sync: () => ({
      get lsp() {
        return {
          get executable(): undefined | { command: string; args: string[] } {
            const lspPath = vscode.workspace
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
    }),
  },
) {}
