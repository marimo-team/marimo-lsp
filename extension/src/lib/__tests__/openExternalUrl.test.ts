import * as Vitest from "@effect/vitest";
import { Effect } from "effect";

import * as VsCodeTest from "../../__tests__/fake/VsCode.ts";
import * as EffectTest from "../../__tests__/lib/EffectTest.ts";
import { openExternalUrl } from "../openExternalUrl.ts";

const test = EffectTest.make(VsCodeTest.layer);

test.effect(
  "opens a parsed HTTPS URL externally",
  Effect.fn(function* () {
    const vscode = yield* VsCodeTest.Service;

    yield* openExternalUrl("https://marimo.io/discord");

    Vitest.expect((yield* vscode.snapshot).openedExternalUris).toEqual([
      "https://marimo.io/discord",
    ]);
  }),
);
