import { Layer, LogLevel } from "effect";

import { LoggerLive } from "./features/Logger.ts";
import { makeActivate } from "./features/Main.ts";
import { LanguageClient } from "./lsp/LanguageClient.ts";
import { RuffLanguageServer } from "./lsp/RuffLanguageServer.ts";
import { TyLanguageServer } from "./lsp/TyLanguageServer.ts";
import { OutputChannel } from "./platform/OutputChannel.ts";
import { VsCode } from "./platform/VsCode.ts";
import { PythonExtension } from "./python/PythonExtension.ts";
import { Sentry } from "./telemetry/Sentry.ts";
import { Telemetry } from "./telemetry/Telemetry.ts";

export const activate = makeActivate(
  Layer.empty.pipe(
    Layer.provideMerge(TyLanguageServer.Default),
    Layer.provideMerge(RuffLanguageServer.Default),
    Layer.provideMerge(PythonExtension.Default),
    Layer.provideMerge(LanguageClient.Default),
    Layer.provideMerge(Telemetry.Default),
    Layer.provide(LoggerLive),
    Layer.provide(OutputChannel.Default),
    Layer.provideMerge(Sentry.Default),
    Layer.provideMerge(VsCode.Default),
  ),
  LogLevel.All,
);

export async function deactivate() {
  // No-op: VSCode will call `dispose()` on the returned `Disposable`
  // from `activate()`, which closes the scope and releases all resources.
}
