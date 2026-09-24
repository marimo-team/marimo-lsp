import * as Vitest from "@effect/vitest";
import { Effect, Fiber, Option } from "effect";

import * as EffectTest from "../../../__tests__/__utils__/EffectTest.ts";
import * as TestNotebookVariables from "./TestNotebookVariables.ts";

Vitest.describe("NotebookVariables", () => {
  const it = EffectTest.make(TestNotebookVariables.layer);

  it.effect(
    "returns None when no variables exist for a notebook",
    Effect.fn(function* () {
      const variables = yield* TestNotebookVariables.Service;
      const current = yield* variables.current();

      Vitest.expect(Option.isNone(current.variables)).toBe(true);
      Vitest.expect(Option.isNone(current.values)).toBe(true);
    }),
  );

  it.effect(
    "updates and retrieves variable declarations",
    Effect.fn(function* () {
      const variables = yield* TestNotebookVariables.Service;
      yield* variables.updateDeclarations([
        { name: "x", declared_by: ["cell1"], used_by: ["cell2"] },
        { name: "y", declared_by: ["cell2"], used_by: [] },
      ]);

      const declarations = Option.getOrThrow(
        (yield* variables.current()).variables,
      );
      Vitest.expect(declarations.map(({ name }) => name)).toEqual(["x", "y"]);
    }),
  );

  it.effect(
    "updates and retrieves variable values",
    Effect.fn(function* () {
      const variables = yield* TestNotebookVariables.Service;
      yield* variables.updateValues([
        { name: "x", value: 42, datatype: "int" },
        { name: "y", value: "hello", datatype: "str" },
      ]);

      const values = Option.getOrThrow((yield* variables.current()).values);
      Vitest.expect(values).toHaveLength(2);
      Vitest.expect(values[0]).toMatchObject({ name: "x", value: 42 });
    }),
  );

  it.effect(
    "gets all variable data for a notebook",
    Effect.fn(function* () {
      const variables = yield* TestNotebookVariables.Service;
      yield* variables.updateDeclarations([
        { name: "x", declared_by: ["cell1"], used_by: [] },
      ]);
      yield* variables.updateValues([
        { name: "x", value: 100, datatype: "int" },
      ]);

      const current = yield* variables.current();
      Vitest.expect(Option.getOrThrow(current.variables)[0]?.name).toBe("x");
      Vitest.expect(Option.getOrThrow(current.values)[0]?.value).toBe(100);
    }),
  );

  it.effect(
    "handles multiple notebooks independently",
    Effect.fn(function* () {
      const variables = yield* TestNotebookVariables.Service;
      yield* variables.updateDeclarations(
        [{ name: "a", declared_by: ["cell1"], used_by: [] }],
        TestNotebookVariables.NOTEBOOK_URI_1,
      );
      yield* variables.updateDeclarations(
        [{ name: "b", declared_by: ["cell2"], used_by: [] }],
        TestNotebookVariables.NOTEBOOK_URI_2,
      );

      const first = Option.getOrThrow(
        (yield* variables.current(TestNotebookVariables.NOTEBOOK_URI_1))
          .variables,
      );
      const second = Option.getOrThrow(
        (yield* variables.current(TestNotebookVariables.NOTEBOOK_URI_2))
          .variables,
      );
      Vitest.expect(first[0]?.name).toBe("a");
      Vitest.expect(second[0]?.name).toBe("b");
    }),
  );

  it.effect(
    "releases all data when a notebook session ends",
    Effect.fn(function* () {
      const variables = yield* TestNotebookVariables.Service;
      const declarations = [{ name: "x", declared_by: ["cell1"], used_by: [] }];
      const values = [{ name: "x", value: 123, datatype: "int" }];
      yield* variables.updateDeclarations(declarations);
      yield* variables.updateValues(values);

      const beforeClose = yield* variables.current();
      yield* variables.closeCurrent();
      const afterClose = yield* variables.current();
      yield* variables.updateDeclarations(declarations);
      yield* variables.updateValues(values);
      const afterLateUpdate = yield* variables.current();

      Vitest.expect(Option.isSome(beforeClose.variables)).toBe(true);
      Vitest.expect(Option.isSome(beforeClose.values)).toBe(true);
      Vitest.expect(Option.isNone(afterClose.variables)).toBe(true);
      Vitest.expect(Option.isNone(afterClose.values)).toBe(true);
      Vitest.expect(Option.isNone(afterLateUpdate.variables)).toBe(true);
      Vitest.expect(Option.isNone(afterLateUpdate.values)).toBe(true);
    }),
  );

  it.effect(
    "keeps replacement-session state isolated from the displaced session",
    Effect.fn(function* () {
      const variables = yield* TestNotebookVariables.Service;
      yield* variables.updateDeclarations([
        { name: "old", declared_by: ["cell1"], used_by: [] },
      ]);
      yield* variables.replaceSession();
      const beforeReplacementUpdate = yield* variables.current();
      yield* variables.updateDeclarations([
        { name: "new", declared_by: ["cell2"], used_by: [] },
      ]);
      yield* variables.closeDisplaced();

      Vitest.expect(Option.isNone(beforeReplacementUpdate.variables)).toBe(
        true,
      );
      Vitest.expect(
        Option.getOrThrow((yield* variables.current()).variables)[0]?.name,
      ).toBe("new");
    }),
  );

  it.effect(
    "streams variable declaration changes",
    Effect.fn(function* () {
      const variables = yield* TestNotebookVariables.Service;
      const count = yield* variables
        .collectDeclarationChanges(4)
        .pipe(Effect.forkChild);
      yield* variables.declarationSubscriptionStarted;

      yield* variables.updateDeclarations([
        { name: "x", declared_by: ["cell1"], used_by: [] },
      ]);
      yield* variables.updateDeclarations([
        { name: "y", declared_by: ["cell2"], used_by: [] },
      ]);
      yield* variables.updateDeclarations([
        { name: "x", declared_by: ["cell1"], used_by: [] },
        { name: "z", declared_by: ["cell3"], used_by: [] },
      ]);

      Vitest.expect(yield* Fiber.join(count)).toBe(4);
    }),
  );

  it.effect(
    "streams variable value changes",
    Effect.fn(function* () {
      const variables = yield* TestNotebookVariables.Service;
      const count = yield* variables
        .collectValueChanges(3)
        .pipe(Effect.forkChild);
      yield* variables.valueSubscriptionStarted;

      yield* variables.updateValues([{ name: "x", value: 1, datatype: "int" }]);
      yield* variables.updateValues([{ name: "x", value: 2, datatype: "int" }]);

      Vitest.expect(yield* Fiber.join(count)).toBe(3);
    }),
  );

  it.effect(
    "preserves variable values when updating variable declarations",
    Effect.fn(function* () {
      const variables = yield* TestNotebookVariables.Service;
      yield* variables.updateValues([
        { name: "x", value: 42, datatype: "int" },
        { name: "y", value: "hello", datatype: "str" },
        { name: "z", value: 3.14, datatype: "float" },
      ]);
      yield* variables.updateDeclarations([
        { name: "x", declared_by: ["cell1"], used_by: ["cell2"] },
        { name: "y", declared_by: ["cell2"], used_by: [] },
      ]);

      const values = Option.getOrThrow((yield* variables.current()).values);
      Vitest.expect(values).toEqual([
        Vitest.expect.objectContaining({ name: "x", value: 42 }),
        Vitest.expect.objectContaining({ name: "y", value: "hello" }),
      ]);
    }),
  );
});
