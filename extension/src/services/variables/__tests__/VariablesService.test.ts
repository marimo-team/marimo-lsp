import { expect, it } from "@effect/vitest";
import { Brand, Effect, Layer, Option, Ref, Stream, TestClock } from "effect";
import type {
  NotebookUri,
  VariablesOp,
  VariableValuesOp,
} from "../../../types.ts";
import { VariablesService } from "../VariablesService.ts";

function makeVariablesLayer() {
  return Layer.empty.pipe(Layer.provideMerge(VariablesService.Default));
}

// Helper to create NotebookUri
function makeNotebookUri(path: string): NotebookUri {
  return Brand.nominal<NotebookUri>()(path);
}
const NOTEBOOK_URI = makeNotebookUri("file:///test/notebook.py");

// Mock data factories
function createMockVariablesOp(
  variables: Array<{ name: string; declared_by: string[]; used_by: string[] }>,
): VariablesOp {
  return {
    op: "variables",
    variables: variables as VariablesOp["variables"],
  };
}

function createMockVariableValuesOp(
  variables: Array<{
    name: string;
    value: string | number | null;
    datatype: string | null;
  }>,
): VariableValuesOp {
  return {
    op: "variable-values",
    variables: variables as VariableValuesOp["variables"],
  };
}

it.effect(
  "should return None when no variables exist for a notebook",
  Effect.fnUntraced(function* () {
    yield* Effect.provide(
      Effect.gen(function* () {
        const service = yield* VariablesService;
        const notebookUri = NOTEBOOK_URI;

        const variables = yield* service.getVariables(notebookUri);
        expect(Option.isNone(variables)).toBe(true);

        const values = yield* service.getVariableValues(notebookUri);
        expect(Option.isNone(values)).toBe(true);
      }),
      makeVariablesLayer(),
    );
  }),
);

it.effect(
  "should update and retrieve variable declarations",
  Effect.fnUntraced(function* () {
    yield* Effect.provide(
      Effect.gen(function* () {
        const service = yield* VariablesService;
        const notebookUri = NOTEBOOK_URI;

        const mockOp = createMockVariablesOp([
          { name: "x", declared_by: ["cell1"], used_by: ["cell2"] },
          { name: "y", declared_by: ["cell2"], used_by: [] },
        ]);

        // Update variables
        yield* service.updateVariables(notebookUri, mockOp);

        // Retrieve variables
        const variables = yield* service.getVariables(notebookUri);
        expect(Option.isSome(variables)).toBe(true);
        if (Option.isSome(variables)) {
          expect(variables.value.variables.length).toBe(2);
          expect(variables.value.variables[0].name).toBe("x");
          expect(variables.value.variables[1].name).toBe("y");
        }
      }),
      makeVariablesLayer(),
    );
  }),
);

it.effect(
  "should update and retrieve variable values",
  Effect.fnUntraced(function* () {
    yield* Effect.provide(
      Effect.gen(function* () {
        const service = yield* VariablesService;
        const notebookUri = NOTEBOOK_URI;

        const mockOp = createMockVariableValuesOp([
          { name: "x", value: 42, datatype: "int" },
          { name: "y", value: "hello", datatype: "str" },
        ]);

        // Update values
        yield* service.updateVariableValues(notebookUri, mockOp);

        // Retrieve values
        const values = yield* service.getVariableValues(notebookUri);
        expect(Option.isSome(values)).toBe(true);
        if (Option.isSome(values)) {
          expect(values.value.variables.length).toBe(2);
          expect(values.value.variables[0].name).toBe("x");
          expect(values.value.variables[0].value).toBe(42);
        }
      }),
      makeVariablesLayer(),
    );
  }),
);

it.effect(
  "should get all variable data for a notebook",
  Effect.fnUntraced(function* () {
    yield* Effect.provide(
      Effect.gen(function* () {
        const service = yield* VariablesService;
        const notebookUri = NOTEBOOK_URI;

        const mockVariables = createMockVariablesOp([
          { name: "x", declared_by: ["cell1"], used_by: [] },
        ]);
        const mockValues = createMockVariableValuesOp([
          { name: "x", value: 100, datatype: "int" },
        ]);

        // Update both
        yield* service.updateVariables(notebookUri, mockVariables);
        yield* service.updateVariableValues(notebookUri, mockValues);

        // Get all data
        const allData = yield* service.getAllVariableData(notebookUri);
        expect(Option.isSome(allData.variables)).toBe(true);
        expect(Option.isSome(allData.values)).toBe(true);

        if (Option.isSome(allData.variables) && Option.isSome(allData.values)) {
          expect(allData.variables.value.variables[0].name).toBe("x");
          expect(allData.values.value.variables[0].value).toBe(100);
        }
      }),
      makeVariablesLayer(),
    );
  }),
);

it.effect(
  "should handle multiple notebooks independently",
  Effect.fnUntraced(function* () {
    yield* Effect.provide(
      Effect.gen(function* () {
        const service = yield* VariablesService;
        const notebook1 = makeNotebookUri("file:///test/notebook1.py");
        const notebook2 = makeNotebookUri("file:///test/notebook2.py");

        const mockOp1 = createMockVariablesOp([
          { name: "a", declared_by: ["cell1"], used_by: [] },
        ]);
        const mockOp2 = createMockVariablesOp([
          { name: "b", declared_by: ["cell2"], used_by: [] },
        ]);

        // Update both notebooks
        yield* service.updateVariables(notebook1, mockOp1);
        yield* service.updateVariables(notebook2, mockOp2);

        // Verify they're separate
        const vars1 = yield* service.getVariables(notebook1);
        const vars2 = yield* service.getVariables(notebook2);

        expect(Option.isSome(vars1)).toBe(true);
        expect(Option.isSome(vars2)).toBe(true);

        if (Option.isSome(vars1) && Option.isSome(vars2)) {
          expect(vars1.value.variables[0].name).toBe("a");
          expect(vars2.value.variables[0].name).toBe("b");
        }
      }),
      makeVariablesLayer(),
    );
  }),
);

it.effect(
  "should clear all data for a notebook",
  Effect.fnUntraced(function* () {
    yield* Effect.provide(
      Effect.gen(function* () {
        const service = yield* VariablesService;
        const notebookUri = NOTEBOOK_URI;

        const mockVariables = createMockVariablesOp([
          { name: "x", declared_by: ["cell1"], used_by: [] },
        ]);
        const mockValues = createMockVariableValuesOp([
          { name: "x", value: 123, datatype: "int" },
        ]);

        // Add data
        yield* service.updateVariables(notebookUri, mockVariables);
        yield* service.updateVariableValues(notebookUri, mockValues);

        // Verify data exists
        const beforeClear = yield* service.getAllVariableData(notebookUri);
        expect(Option.isSome(beforeClear.variables)).toBe(true);
        expect(Option.isSome(beforeClear.values)).toBe(true);

        // Clear notebook
        yield* service.clearNotebook(notebookUri);

        // Verify data is gone
        const afterClear = yield* service.getAllVariableData(notebookUri);
        expect(Option.isNone(afterClear.variables)).toBe(true);
        expect(Option.isNone(afterClear.values)).toBe(true);
      }),
      makeVariablesLayer(),
    );
  }),
);

it.effect(
  "should stream variable declaration changes",
  Effect.fnUntraced(function* () {
    yield* Effect.provide(
      Effect.gen(function* () {
        const service = yield* VariablesService;
        const notebookUri = NOTEBOOK_URI;

        const collected = yield* Ref.make<number>(0);

        // Subscribe to stream and count changes
        yield* Effect.fork(
          service.streamVariablesChanges().pipe(
            Stream.mapEffect(() => Ref.update(collected, (n) => n + 1)),
            Stream.runDrain,
          ),
        );

        // Initial state
        yield* TestClock.adjust("10 millis");

        // Make changes
        yield* service.updateVariables(
          notebookUri,
          createMockVariablesOp([
            { name: "x", declared_by: ["cell1"], used_by: [] },
          ]),
        );
        yield* TestClock.adjust("10 millis");

        yield* service.updateVariables(
          notebookUri,
          createMockVariablesOp([
            { name: "y", declared_by: ["cell2"], used_by: [] },
          ]),
        );
        yield* TestClock.adjust("10 millis");

        yield* service.updateVariables(
          notebookUri,
          createMockVariablesOp([
            { name: "x", declared_by: ["cell1"], used_by: [] },
            { name: "z", declared_by: ["cell3"], used_by: [] },
          ]),
        );
        yield* TestClock.adjust("10 millis");

        const count = yield* Ref.get(collected);
        // Expects 4 because SubscriptionRef.changes emits current value on subscription (empty map)
        // plus the 3 updates
        expect(count).toBe(4);
      }),
      makeVariablesLayer(),
    );
  }),
);

it.effect(
  "should stream variable value changes",
  Effect.fnUntraced(function* () {
    yield* Effect.provide(
      Effect.gen(function* () {
        const service = yield* VariablesService;
        const notebookUri = NOTEBOOK_URI;

        const collected = yield* Ref.make<number>(0);

        // Subscribe to stream and count changes
        yield* Effect.fork(
          service.streamVariableValuesChanges().pipe(
            Stream.mapEffect(() => Ref.update(collected, (n) => n + 1)),
            Stream.runDrain,
          ),
        );

        // Let stream start
        yield* TestClock.adjust("10 millis");

        // Make changes
        yield* service.updateVariableValues(
          notebookUri,
          createMockVariableValuesOp([
            { name: "x", value: 1, datatype: "int" },
          ]),
        );
        yield* TestClock.adjust("10 millis");

        yield* service.updateVariableValues(
          notebookUri,
          createMockVariableValuesOp([
            { name: "x", value: 2, datatype: "int" },
          ]),
        );
        yield* TestClock.adjust("10 millis");

        const count = yield* Ref.get(collected);
        // Expects 3 because SubscriptionRef.changes emits current value on subscription (empty map)
        // plus the 2 updates
        expect(count).toBe(3);
      }),
      makeVariablesLayer(),
    );
  }),
);

it.effect(
  "should preserve variable values when updating variable declarations",
  Effect.fnUntraced(function* () {
    yield* Effect.provide(
      Effect.gen(function* () {
        const service = yield* VariablesService;
        const notebookUri = NOTEBOOK_URI;

        // Set initial variable values
        yield* service.updateVariableValues(
          notebookUri,
          createMockVariableValuesOp([
            { name: "x", value: 42, datatype: "int" },
            { name: "y", value: "hello", datatype: "str" },
            { name: "z", value: 3.14, datatype: "float" },
          ]),
        );

        // Update variable declarations - only x and y are declared now
        yield* service.updateVariables(
          notebookUri,
          createMockVariablesOp([
            { name: "x", declared_by: ["cell1"], used_by: ["cell2"] },
            { name: "y", declared_by: ["cell2"], used_by: [] },
          ]),
        );

        // Values for x and y should be preserved, z should be removed
        const values = yield* service.getVariableValues(notebookUri);
        expect(Option.isSome(values)).toBe(true);
        if (Option.isSome(values)) {
          expect(values.value.variables.length).toBe(2);
          const xValue = values.value.variables.find((v) => v.name === "x");
          const yValue = values.value.variables.find((v) => v.name === "y");
          const zValue = values.value.variables.find((v) => v.name === "z");

          expect(xValue).toBeDefined();
          expect(xValue?.value).toBe(42);
          expect(yValue).toBeDefined();
          expect(yValue?.value).toBe("hello");
          expect(zValue).toBeUndefined();
        }
      }),
      makeVariablesLayer(),
    );
  }),
);
