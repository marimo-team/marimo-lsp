import { Effect, Layer, Stream } from "effect";

import { makeMarimoCommands, MarimoClient } from "../../lsp/MarimoClient.ts";
import type { MarimoApiRequest, MarimoOperation } from "../../types.ts";

interface Options {
  readonly execute?: (request: MarimoApiRequest) => Effect.Effect<unknown>;
  readonly operations?: () => Stream.Stream<MarimoOperation>;
}

export function makeTestMarimoClient(options: Options = {}) {
  return Layer.succeed(
    MarimoClient,
    MarimoClient.make({
      channel: { name: "marimo-lsp-test", show() {} },
      restart: () => Effect.void,
      ...makeMarimoCommands({
        execute: options.execute ?? (() => Effect.void),
        operations: options.operations ?? (() => Stream.never),
      }),
    }),
  );
}
