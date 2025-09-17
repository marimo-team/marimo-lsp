import { Context, Data, Effect, Layer } from "effect";
import type * as lsp from "vscode-languageclient";
import { executeCommand } from "./commands.ts";

import type { MarimoCommand } from "./types.ts";

type ParamsFor<Command extends MarimoCommand["command"]> = Extract<
  MarimoCommand,
  { command: Command }
>["params"];

export class RawLanguageClient extends Context.Tag("LanguageClient")<
  RawLanguageClient,
  lsp.BaseLanguageClient
>() {
  static layer = (client: lsp.BaseLanguageClient) =>
    Layer.succeed(this, client);
}

class ExecuteCommandError extends Data.TaggedError("ExecuteCommandError")<{
  readonly command: MarimoCommand;
  readonly error: unknown;
}> {}

export class MarimoLanguageClient extends Effect.Service<MarimoLanguageClient>()(
  "MarimoLanguageClient",
  {
    effect: Effect.gen(function* () {
      const client = yield* RawLanguageClient;

      function exec(command: MarimoCommand) {
        return Effect.tryPromise({
          try: () => executeCommand(client, command),
          catch: (error) => new ExecuteCommandError({ command, error }),
        });
      }

      return {
        client,
        run(params: ParamsFor<"marimo.run">) {
          return exec({ command: "marimo.run", params });
        },
        setUiElementValue(params: ParamsFor<"marimo.set_ui_element_value">) {
          return exec({ command: "marimo.set_ui_element_value", params });
        },
        serialize(params: ParamsFor<"marimo.serialize">) {
          return exec({ command: "marimo.serialize", params });
        },
        deserialize(params: ParamsFor<"marimo.deserialize">) {
          return exec({ command: "marimo.deserialize", params });
        },
      };
    }),
  },
) {}
