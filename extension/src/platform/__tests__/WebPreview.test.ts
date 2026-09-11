import { expect, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { afterEach, vi } from "vitest";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { HostPlatform } from "../HostPlatform.ts";
import { WebPreview } from "../WebPreview.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

it.effect(
  "previews URLs externally in VS Code",
  Effect.fn(function* () {
    const opened = yield* Ref.make<ReadonlyArray<string>>([]);
    const vscode = yield* TestVsCode.make({
      env: {
        openExternal: (uri) =>
          Ref.update(opened, (urls) => [...urls, uri.toString(true)]).pipe(
            Effect.as(true),
          ),
      },
    });
    const layer = HostPlatform.Live.pipe(Layer.provide(vscode.layer));

    yield* Effect.gen(function* () {
      const preview = yield* WebPreview;
      yield* preview.open("https://docs.marimo.io");
    }).pipe(Effect.provide(layer));

    expect(yield* Ref.get(opened)).toEqual(["https://docs.marimo.io/"]);
  }),
);

it.effect(
  "previews URLs in the Positron viewer",
  Effect.fn(function* () {
    const previewUrl = vi.fn();
    vi.stubGlobal("acquirePositronApi", () => ({
      window: { previewUrl },
    }));
    const vscode = yield* TestVsCode.make();
    const layer = HostPlatform.Live.pipe(Layer.provide(vscode.layer));

    yield* Effect.gen(function* () {
      const preview = yield* WebPreview;
      yield* preview.open("https://docs.marimo.io");
    }).pipe(Effect.provide(layer));

    expect(previewUrl).toHaveBeenCalledOnce();
    expect(previewUrl.mock.calls[0][0].toString(true)).toBe(
      "https://docs.marimo.io/",
    );
  }),
);
