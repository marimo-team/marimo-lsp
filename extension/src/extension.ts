import { Layer, LogLevel } from "effect";
import { LoggerLive } from "./layers/Logger.ts";
import { makeActivate } from "./layers/Main.ts";
import { LanguageClient } from "./services/LanguageClient.ts";
import { OutputChannel } from "./services/OutputChannel.ts";
import { PythonExtension } from "./services/PythonExtension.ts";
import { VsCode } from "./services/VsCode.ts";
import { Sentry } from "./services/Sentry.ts";

export const activate = makeActivate(
  Layer.empty.pipe(
    Layer.provideMerge(PythonExtension.Default),
    Layer.provideMerge(LanguageClient.Default),
    Layer.provide(LoggerLive),
    Layer.provide(Sentry.Default),
    Layer.provide(OutputChannel.Default),
    Layer.provideMerge(VsCode.Default),
  ),
  LogLevel.All,
);

export async function deactivate() {
  // No-op: VSCode will call `dispose()` on the returned `Disposable`
  // from `activate()`, which closes the scope and releases all resources.
}
