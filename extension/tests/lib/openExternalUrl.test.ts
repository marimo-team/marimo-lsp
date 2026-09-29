import * as Vitest from "@effect/vitest";
import { Effect } from "effect";

import { openExternalUrl } from "../../src/lib/openExternalUrl.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as EffectTest from "./EffectTest.ts";

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
