import { Effect, Layer } from "effect";
import { MarimoDebugAdapter } from "../services/DebugAdapter.ts";
import { MarimoConfig } from "../services/MarimoConfig.ts";
import { MarimoLanguageClient } from "../services/MarimoLanguageClient.ts";
import { MarimoNotebookControllers } from "../services/MarimoNotebookControllers.ts";
import { MarimoNotebookRenderer } from "../services/MarimoNotebookRenderer.ts";
import { MarimoNotebookSerializer } from "../services/MarimoNotebookSerializer.ts";
import { PythonExtension } from "../services/PythonExtension.ts";
import { VsCode } from "../services/VsCode.ts";

import { KernelManagerLive } from "./KernelManager.ts";
import { LoggerLive } from "./Logger.ts";
import { RegisterCommandsLive } from "./RegisterCommands.ts";

const ServerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const client = yield* MarimoLanguageClient;
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
        yield* code.window.useInfallable((api) =>
          api.showErrorMessage(
            `Marimo language server failed to start. See marimo logs for more info.`,
          ),
        );
      }),
    ),
  ),
);

export const MainLive = ServerLive.pipe(
  Layer.merge(RegisterCommandsLive),
  Layer.merge(KernelManagerLive),
  Layer.provide(MarimoDebugAdapter.Default),
  Layer.provide(MarimoNotebookRenderer.Default),
  Layer.provide(MarimoNotebookControllers.Default),
  Layer.provide(MarimoNotebookSerializer.Default),
  Layer.provide(PythonExtension.Default),
  Layer.provide(MarimoLanguageClient.Default),
  Layer.provide(MarimoConfig.Default),
  Layer.provide(LoggerLive),
  Layer.provide(VsCode.Default),
);
