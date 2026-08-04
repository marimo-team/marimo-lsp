import { expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { openExternalUrl } from "../openExternalUrl.ts";

it.effect(
  "opens a parsed HTTPS URL externally",
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

    yield* openExternalUrl("https://marimo.io/discord").pipe(
      Effect.provide(vscode.layer),
    );

    expect(yield* opened).toEqual(["https://marimo.io/discord"]);
  }),
);
