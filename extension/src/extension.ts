import { Layer, LogLevel } from "effect";

import { LoggerLive } from "./features/Logger.ts";
import { makeExtension } from "./features/Main.ts";
import { MarimoClient } from "./lsp/MarimoClient.ts";
import { RuffLanguageServer } from "./lsp/RuffLanguageServer.ts";
import { TyLanguageServer } from "./lsp/TyLanguageServer.ts";
import { OutputChannel } from "./platform/OutputChannel.ts";
import { VsCode } from "./platform/VsCode.ts";
import { PythonExtension } from "./python/PythonExtension.ts";
import { Telemetry } from "./telemetry/Telemetry.ts";

export const { activate, deactivate } = makeExtension(
  Layer.empty.pipe(
    Layer.provideMerge(TyLanguageServer.layer),
    Layer.provideMerge(RuffLanguageServer.layer),
    Layer.provideMerge(PythonExtension.layer),
    Layer.provideMerge(MarimoClient.layer),
    Layer.provide(LoggerLive),
    Layer.provide(OutputChannel.layer),
    // Below LoggerLive so the logger's error sink can come from Telemetry;
    // Telemetry's own construction therefore logs without it.
    Layer.provideMerge(Telemetry.layer),
    Layer.provideMerge(VsCode.layer),
  ),
  LogLevel.All,
);
