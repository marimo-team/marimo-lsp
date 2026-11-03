import * as Vitest from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, vi } from "vitest";

import * as HostPlatform from "../../src/platform/HostPlatform.ts";
import * as WebPreview from "../../src/platform/WebPreview.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as EffectTest from "../lib/EffectTest.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});
const it = EffectTest.make(
  HostPlatform.layer.pipe(Layer.provideMerge(VsCodeTest.layer)),
);
it.effect(
  "previews URLs externally in VS Code",
  Effect.fn(function* () {
    const preview = yield* WebPreview.Service;
    const code = yield* VsCodeTest.Service;
    yield* preview.open("https://docs.marimo.io");
    Vitest.expect((yield* code.snapshot).openedExternalUris).toEqual([
      "https://docs.marimo.io/",
    ]);
  }),
);
Vitest.it.effect(
  "previews URLs in the Positron viewer",
  Effect.fn(function* () {
    const previewUrl = vi.fn();
    vi.stubGlobal("acquirePositronApi", () => ({ window: { previewUrl } }));
    yield* Effect.gen(function* () {
      const preview = yield* WebPreview.Service;
      yield* preview.open("https://docs.marimo.io");
    }).pipe(
      Effect.provide(HostPlatform.layer.pipe(Layer.provide(VsCodeTest.layer))),
    );
    Vitest.expect(previewUrl).toHaveBeenCalledOnce();
    Vitest.expect(previewUrl.mock.calls[0][0].toString(true)).toBe(
      "https://docs.marimo.io/",
    );
  }),
);
