import { Layer } from "effect";
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
import { MarimoLspLive } from "./MarimoLsp.ts";
import { RegisterCommandsLive } from "./RegisterCommands.ts";

export const MainLive = MarimoLspLive.pipe(
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
