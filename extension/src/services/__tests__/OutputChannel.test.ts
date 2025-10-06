import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestVsCodeLive } from "../../__mocks__/TestVsCode.ts";
import { OutputChannel } from "../OutputChannel.ts";

const OutputChannelLive = Layer.empty.pipe(
  Layer.provideMerge(OutputChannel.Default),
  Layer.provide(TestVsCodeLive),
);

it.layer(OutputChannelLive)("OutputChannel", (it) => {
  it.effect(
    "should build",
    Effect.fnUntraced(function* () {
      const api = yield* OutputChannel;
      expect(api).toBeDefined();
    }),
  );
});
