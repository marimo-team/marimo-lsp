import { expect } from "@effect/vitest";
import { Effect } from "effect";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import openOutlineView from "../openOutlineView.ts";

const test = EffectTest.make(TestVsCode.layer);

test.effect(
  "focuses the built-in VS Code Outline view",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;

    yield* openOutlineView.invoke();

    expect((yield* vscode.snapshot).executions).toEqual([
      { command: "outline.focus", args: [] },
    ]);
  }),
);
