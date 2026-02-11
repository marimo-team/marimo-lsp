import { Layer, LogLevel } from "effect";

import { LoggerLive } from "./layers/Logger.ts";
import { makeActivate } from "./layers/Main.ts";
import { RuffLanguageServer } from "./services/completions/RuffLanguageServer.ts";
import { TyLanguageServer } from "./services/completions/TyLanguageServer.ts";
import { LanguageClient } from "./services/LanguageClient.ts";
import { OutputChannel } from "./services/OutputChannel.ts";
import { PythonExtension } from "./services/PythonExtension.ts";
import { Sentry } from "./services/Sentry.ts";
import { Telemetry } from "./services/Telemetry.ts";
import { VsCode } from "./services/VsCode.ts";

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
