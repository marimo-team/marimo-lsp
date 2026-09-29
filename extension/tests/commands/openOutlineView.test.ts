import * as Vitest from "@effect/vitest";
import { Effect } from "effect";

import openOutlineView from "../../src/commands/openOutlineView.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as EffectTest from "../lib/EffectTest.ts";

const test = EffectTest.make(VsCodeTest.layer);

test.effect(
  "focuses the built-in VS Code Outline view",
  Effect.fn(function* () {
    const vscode = yield* VsCodeTest.Service;

    yield* openOutlineView.invoke();

    Vitest.expect((yield* vscode.snapshot).executions).toEqual([
      { command: "outline.focus", args: [] },
    ]);
  }),
);
