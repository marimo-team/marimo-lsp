import * as Vitest from "@effect/vitest";
import { Effect } from "effect";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import { openExternalUrl } from "../openExternalUrl.ts";

const test = EffectTest.make(TestVsCode.layer);

test.effect(
  "opens a parsed HTTPS URL externally",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;

    yield* openExternalUrl("https://marimo.io/discord");

    Vitest.expect((yield* vscode.snapshot).openedExternalUris).toEqual([
      "https://marimo.io/discord",
    ]);
  }),
);
