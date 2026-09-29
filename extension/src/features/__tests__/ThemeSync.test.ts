import * as Vitest from "@effect/vitest";
import { Effect, Option } from "effect";

import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import * as TestThemeSync from "./TestThemeSync.ts";

const it = EffectTest.make(TestThemeSync.layerWith("light"));
const darkIt = EffectTest.make(TestThemeSync.layerWith("dark"));

Vitest.describe("ThemeSync", () => {
  it.effect(
    "sends set-display-theme on theme change",
    Effect.fn(function* () {
      const test = yield* TestThemeSync.Service;
      yield* test.vscode.setActiveNotebookEditor(Option.some(test.editor));
      yield* test.awaitExecutions((executions) => executions.length >= 2);

      yield* test.setTheme("dark");
      yield* test.awaitExecutions((executions) =>
        executions.some(
          (execution) =>
            execution.kind === "set-display-theme" &&
            execution.theme === "dark",
        ),
      );

      Vitest.expect(yield* test.executions).toMatchInlineSnapshot(`
        [
          {
            "kind": "set-display-theme",
            "theme": "light",
          },
          {
            "kind": "set-display-theme",
            "theme": "light",
          },
          {
            "kind": "set-display-theme",
            "theme": "dark",
          },
        ]
      `);
    }),
  );

  it.effect(
    "sends set-display-theme while no marimo notebook is active",
    Effect.fn(function* () {
      const test = yield* TestThemeSync.Service;
      yield* test.vscode.setActiveNotebookEditor(Option.none());
      yield* test.awaitExecutions((executions) => executions.length >= 1);

      yield* test.setTheme("dark");
      yield* test.awaitExecutions((executions) =>
        executions.some(
          (execution) =>
            execution.kind === "set-display-theme" &&
            execution.theme === "dark",
        ),
      );

      Vitest.expect(yield* test.executions).toContainEqual({
        kind: "set-display-theme",
        theme: "dark",
      });
    }),
  );

  darkIt.effect(
    "syncs theme when a new notebook becomes active",
    Effect.fn(function* () {
      const test = yield* TestThemeSync.Service;
      yield* test.vscode.setActiveNotebookEditor(Option.some(test.editor));
      yield* test.awaitExecutions((executions) => executions.length >= 2);

      Vitest.expect(yield* test.executions).toMatchInlineSnapshot(`
        [
          {
            "kind": "set-display-theme",
            "theme": "dark",
          },
          {
            "kind": "set-display-theme",
            "theme": "dark",
          },
        ]
      `);
    }),
  );
});
