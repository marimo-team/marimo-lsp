import * as NodeChildProcess from "node:child_process";
import { Effect, Either, Layer } from "effect";

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
    yield* Effect.logInfo("Starting LSP client").pipe(
      Effect.annotateLogs({ component: "server" }),
    );
    yield* client.manage();
    yield* Effect.logInfo("LSP client started").pipe(
      Effect.annotateLogs({ component: "server" }),
    );
    yield* Effect.logInfo("Extension main fiber running").pipe(
      Effect.annotateLogs({ component: "server" }),
    );
  }).pipe(
    Effect.catchTag("LanguageClientStartError", (error) =>
      Effect.gen(function* () {
        const code = yield* VsCode;
        yield* Effect.logError("Failed to start extension", error).pipe(
          Effect.annotateLogs({ component: "server" }),
        );

        if (error.exec.command === "uv" && !isUvInstalled()) {
          yield* Effect.logError("uv is not installed in PATH").pipe(
            Effect.annotateLogs({ component: "server" }),
          );

          const result = yield* code.window.useInfallible((api) =>
            api.showErrorMessage(
              "The marimo VS Code extension currently requires uv to be installed.",
              "Install uv",
              "Try Again",
            ),
          );

          if (result === "Install uv") {
            const uri = Either.getOrThrow(
              code.utils.parseUri(
                "https://docs.astral.sh/uv/getting-started/installation/",
              ),
            );
            yield* code.env.useInfallible((api) => api.openExternal(uri));
          } else if (result === "Try Again") {
            // Reload the window to retry
            yield* code.commands.executeCommand(
              "workbench.action.reloadWindow",
            );
          }
        } else {
          yield* code.window.useInfallible((api) =>
            api.showErrorMessage(
              ` language server failed to start. See marimo logs for more info.`,
            ),
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
