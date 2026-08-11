import { expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import openOutlineView from "../openOutlineView.ts";

it.effect(
  "focuses the built-in VS Code Outline view",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.make();

    yield* openOutlineView.invoke().pipe(Effect.provide(vscode.layer));

    expect(yield* Ref.get(vscode.executions)).toEqual([
      { command: "outline.focus", args: [] },
    ]);
  }),
);
