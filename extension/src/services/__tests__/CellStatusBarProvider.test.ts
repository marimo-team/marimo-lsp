import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { CellStatusBarProvider } from "../CellStatusBarProvider.ts";

const CellStatusBarProviderLive = Layer.empty.pipe(
  Layer.provideMerge(CellStatusBarProvider.Default),
  Layer.provide(TestVsCode.Default),
);

it.layer(CellStatusBarProviderLive)("CellStatusBarProvider", (it) => {
  it.effect(
    "should build",
    Effect.fnUntraced(function* () {
      const api = yield* CellStatusBarProvider;
      expect(api).toBeDefined();
    }),
  );
});
