import { expect, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { WebPreview } from "../WebPreview.ts";

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
    const layer = WebPreview.Default.pipe(Layer.provide(vscode.layer));

    yield* Effect.gen(function* () {
      const preview = yield* WebPreview;
      yield* preview.open("https://docs.marimo.io");
    }).pipe(Effect.provide(layer));

    expect(yield* opened).toEqual(["https://docs.marimo.io/"]);
  }),
);
