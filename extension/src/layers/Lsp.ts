import * as NodeChildProcess from "node:child_process";
import { Effect, Either, Layer, Option } from "effect";
import { logNever } from "@/utils/assertNever.ts";
import { LanguageClient } from "../services/LanguageClient.ts";
import { VsCode } from "../services/VsCode.ts";

/**
 * Manages the marimo LSP client lifecycle.
 *
 * Actually starts marimo-lsp and checks dependencies.
 */
export const LspLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const client = yield* LanguageClient;
    yield* Effect.logInfo("Starting marimo-lsp client");
    yield* client.manage();
    yield* Effect.logInfo("marimo-lsp client started");
  }).pipe(
    Effect.catchTag(
      "LanguageClientStartError",
      Effect.fnUntraced(function* (error) {
        const code = yield* VsCode;
        yield* Effect.logError("Failed to start marimo-lsp", error);

        if (error.exec.command === "uv" && !isUvInstalled()) {
          yield* Effect.logError("uv is not installed in PATH");

          const result = yield* code.window.showErrorMessage(
            "The marimo VS Code extension currently requires uv to be installed.",
            {
              items: ["Install uv", "Try Again"],
            },
          );

          if (Option.isNone(result)) {
            // dissmissed
            return;
          }

          switch (result.value) {
            case "Install uv": {
              const uri = Either.getOrThrow(
                code.utils.parseUri(
                  "https://docs.astral.sh/uv/getting-started/installation/",
                ),
              );
              yield* code.env.openExternal(uri);
              return;
            }
            case "Try Again": {
              yield* code.commands.executeCommand(
                "workbench.action.reloadWindow",
              );
              return;
            }
            default:
              logNever(result.value);
          }
        } else {
          yield* code.window.showErrorMessage(
            `marimo-lsp failed to start. See marimo logs for more info.`,
          );
        }
      }),
    ),
  ),
);

function isUvInstalled(): boolean {
  try {
    NodeChildProcess.execSync("uv --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
