import * as fs from "node:fs";
import * as path from "node:path";
import { Data, Effect } from "effect";
import * as lsp from "vscode-languageclient/node";
import { MarimoConfig } from "./MarimoConfig.ts";
import { OutputChannel } from "./OutputChannel.ts";

export class LanguageClientStartError extends Data.TaggedError(
  "LanguageClientStartError",
)<{
  cause: unknown;
}> {}

export class BaseLanguageClient extends Effect.Service<BaseLanguageClient>()(
  "BaseLanguageClient",
  {
    effect: Effect.gen(function* () {
      yield* Effect.logInfo("Setting up BaseLanguageClient");
      const channel = yield* OutputChannel;
      const exec = yield* getLspExecutable();
      yield* Effect.logInfo(
        `Starting language server with command: ${exec.command} ${(exec.args ?? []).join(" ")}`,
      );
      const client = new lsp.LanguageClient(
        "marimo-lsp",
        "Marimo Language Server",
        { run: exec, debug: exec },
        {
          outputChannel: channel,
          revealOutputChannelOn: lsp.RevealOutputChannelOn.Never,
        },
      );
      return {
        sendRequest: client.sendRequest.bind(client),
        onNotification: client.onNotification.bind(client),
        manage: () =>
          Effect.acquireRelease(
            Effect.tryPromise({
              try: () => client.start(),
              catch: (cause) => new LanguageClientStartError({ cause }),
            }),
            () => Effect.sync(() => client.dispose()),
          ),
      };
    }),
  },
) {}

function getLspExecutable(): Effect.Effect<
  lsp.Executable,
  never,
  MarimoConfig
> {
  return Effect.gen(function* () {
    const config = yield* MarimoConfig;

    if (config.lsp.executable) {
      const { command, args } = config.lsp.executable;
      return {
        command,
        args,
        transport: lsp.TransportKind.stdio,
      };
    }

    // Look for bundled wheel matching marimo_lsp-* pattern
    const sdistDir = fs
      .readdirSync(__dirname)
      .find((f) => f.startsWith("marimo_lsp-"));

    if (sdistDir) {
      const sdist = path.join(__dirname, sdistDir);
      yield* Effect.logInfo(`Using bundled marimo-lsp: ${sdist}`);
      return {
        command: "uvx",
        args: ["--from", sdist, "marimo-lsp"],
        transport: lsp.TransportKind.stdio,
      };
    }

    // Fallback to development mode if no wheel found
    yield* Effect.logWarning(
      `No marimo_lsp*.whl found in ${__dirname}, falling back to development mode`,
    );

    return {
      command: "uv",
      args: ["run", "--directory", __dirname, "marimo-lsp"],
      transport: lsp.TransportKind.stdio,
    };
  });
}
