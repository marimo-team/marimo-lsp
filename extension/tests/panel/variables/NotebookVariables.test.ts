import * as Vitest from "@effect/vitest";
import { Effect, Fiber, Latch, Layer, Option, Stream } from "effect";

import { NOTEBOOK_TYPE } from "../../../src/constants.ts";
import * as NotebookDocumentSessions from "../../../src/notebook/NotebookDocumentSessions.ts";
import * as NotebookVariables from "../../../src/panel/variables/NotebookVariables.ts";
import type { NotebookId } from "../../../src/schemas/MarimoNotebookDocument.ts";
import type {
  VariablesNotification,
  VariableValuesNotification,
} from "../../../src/types.ts";
import * as VsCodeTest from "../../fake/VsCode.ts";
import { notebookId } from "../../lib/branded.ts";
import * as DocumentLifecycle from "../../lib/documentLifecycle.ts";
import * as EffectTest from "../../lib/EffectTest.ts";

const NOTEBOOK_URI = notebookId("file:///test/notebook.py");
const NOTEBOOK_URI_1 = notebookId("file:///test/notebook1.py");
const NOTEBOOK_URI_2 = notebookId("file:///test/notebook2.py");

interface Declaration {
  readonly name: string;
  readonly declared_by: ReadonlyArray<string>;
  readonly used_by: ReadonlyArray<string>;
}

interface Value {
  readonly name: string;
  readonly value: string | number | null;
  readonly datatype: string | null;
}

const declarationsOperation = (
  declarations: ReadonlyArray<Declaration>,
): VariablesNotification => ({
  op: "variables",
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  variables: declarations as VariablesNotification["variables"],
});

const valuesOperation = (
  values: ReadonlyArray<Value>,
): VariableValuesNotification => ({
  op: "variable-values",
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  variables: values as VariableValuesNotification["variables"],
});

const it = EffectTest.make(
  NotebookVariables.layer.pipe(
    Layer.provideMerge(NotebookDocumentSessions.layer),
    Layer.provideMerge(VsCodeTest.layer),
  ),
);

/** Opens a document for the notebook and returns its session. */
const open = Effect.fn("open")(function* (id: NotebookId = NOTEBOOK_URI) {
  const sessions = yield* NotebookDocumentSessions.Service;
  const document = VsCodeTest.createTestNotebookDocument(
    VsCodeTest.Uri.parse(id),
    { notebookType: NOTEBOOK_TYPE },
  );
  yield* DocumentLifecycle.transition(document, "opened");
  return Option.getOrThrow(sessions.current(id));
});

const close = (session: NotebookDocumentSessions.Session) =>
  DocumentLifecycle.transition(session.document, "closed");

const declare = Effect.fn("declare")(function* (
  session: NotebookDocumentSessions.Session,
  declarations: ReadonlyArray<Declaration>,
) {
  const variables = yield* NotebookVariables.Service;
  yield* variables.updateVariables(
    session,
    declarationsOperation(declarations),
  );
});

const assign = Effect.fn("assign")(function* (
  session: NotebookDocumentSessions.Session,
  values: ReadonlyArray<Value>,
) {
  const variables = yield* NotebookVariables.Service;
  yield* variables.updateVariableValues(session, valuesOperation(values));
});

const current = (id: NotebookId = NOTEBOOK_URI) =>
  Effect.flatMap(NotebookVariables.Service, (variables) =>
    variables.getAllVariableData(id),
  );

Vitest.describe("NotebookVariables", () => {
  it.effect(
    "returns None when no variables exist for a notebook",
    Effect.fn(function* () {
      yield* open();
      const state = yield* current();

      Vitest.expect(Option.isNone(state.variables)).toBe(true);
      Vitest.expect(Option.isNone(state.values)).toBe(true);
    }),
  );

  it.effect(
    "updates and retrieves variable declarations",
    Effect.fn(function* () {
      const session = yield* open();
      yield* declare(session, [
        { name: "x", declared_by: ["cell1"], used_by: ["cell2"] },
        { name: "y", declared_by: ["cell2"], used_by: [] },
      ]);

      const declarations = Option.getOrThrow((yield* current()).variables);
      Vitest.expect(declarations.map(({ name }) => name)).toEqual(["x", "y"]);
    }),
  );

  it.effect(
    "updates and retrieves variable values",
    Effect.fn(function* () {
      const session = yield* open();
      yield* assign(session, [
        { name: "x", value: 42, datatype: "int" },
        { name: "y", value: "hello", datatype: "str" },
      ]);

      const values = Option.getOrThrow((yield* current()).values);
      Vitest.expect(values).toHaveLength(2);
      Vitest.expect(values[0]).toMatchObject({ name: "x", value: 42 });
    }),
  );

  it.effect(
    "gets all variable data for a notebook",
    Effect.fn(function* () {
      const session = yield* open();
      yield* declare(session, [
        { name: "x", declared_by: ["cell1"], used_by: [] },
      ]);
      yield* assign(session, [{ name: "x", value: 100, datatype: "int" }]);

      const state = yield* current();
      Vitest.expect(Option.getOrThrow(state.variables)[0]?.name).toBe("x");
      Vitest.expect(Option.getOrThrow(state.values)[0]?.value).toBe(100);
    }),
  );

  it.effect(
    "handles multiple notebooks independently",
    Effect.fn(function* () {
      const first = yield* open(NOTEBOOK_URI_1);
      const second = yield* open(NOTEBOOK_URI_2);
      yield* declare(first, [
        { name: "a", declared_by: ["cell1"], used_by: [] },
      ]);
      yield* declare(second, [
        { name: "b", declared_by: ["cell2"], used_by: [] },
      ]);

      const firstVariables = Option.getOrThrow(
        (yield* current(NOTEBOOK_URI_1)).variables,
      );
      const secondVariables = Option.getOrThrow(
        (yield* current(NOTEBOOK_URI_2)).variables,
      );
      Vitest.expect(firstVariables[0]?.name).toBe("a");
      Vitest.expect(secondVariables[0]?.name).toBe("b");
    }),
  );

  it.effect(
    "releases all data when a notebook session ends",
    Effect.fn(function* () {
      const session = yield* open();
      const declarations = [{ name: "x", declared_by: ["cell1"], used_by: [] }];
      const values = [{ name: "x", value: 123, datatype: "int" }];
      yield* declare(session, declarations);
      yield* assign(session, values);

      const beforeClose = yield* current();
      yield* close(session);
      const afterClose = yield* current();
      yield* declare(session, declarations);
      yield* assign(session, values);
      const afterLateUpdate = yield* current();

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
      const displaced = yield* open();
      yield* declare(displaced, [
        { name: "old", declared_by: ["cell1"], used_by: [] },
      ]);
      const replacement = yield* open();
      const beforeReplacementUpdate = yield* current();
      yield* declare(replacement, [
        { name: "new", declared_by: ["cell2"], used_by: [] },
      ]);
      yield* declare(displaced, [
        { name: "late", declared_by: ["cell3"], used_by: [] },
      ]);

      Vitest.expect(Option.isNone(beforeReplacementUpdate.variables)).toBe(
        true,
      );
      Vitest.expect(
        Option.getOrThrow((yield* current()).variables).map(({ name }) => name),
      ).toEqual(["new"]);
    }),
  );

  it.effect(
    "streams variable declaration changes",
    Effect.fn(function* () {
      const session = yield* open();
      const variables = yield* NotebookVariables.Service;
      const subscribed = yield* Latch.make();
      const count = yield* variables.streamVariablesChanges.pipe(
        Stream.tap(() => subscribed.open),
        Stream.take(4),
        Stream.runCount,
        Effect.forkChild,
      );
      yield* subscribed.await;

      yield* declare(session, [
        { name: "x", declared_by: ["cell1"], used_by: [] },
      ]);
      yield* declare(session, [
        { name: "y", declared_by: ["cell2"], used_by: [] },
      ]);
      yield* declare(session, [
        { name: "x", declared_by: ["cell1"], used_by: [] },
        { name: "z", declared_by: ["cell3"], used_by: [] },
      ]);

      Vitest.expect(yield* Fiber.join(count)).toBe(4);
    }),
  );

  it.effect(
    "streams variable value changes",
    Effect.fn(function* () {
      const session = yield* open();
      const variables = yield* NotebookVariables.Service;
      const subscribed = yield* Latch.make();
      const count = yield* variables.streamVariableValuesChanges.pipe(
        Stream.tap(() => subscribed.open),
        Stream.take(3),
        Stream.runCount,
        Effect.forkChild,
      );
      yield* subscribed.await;

      yield* assign(session, [{ name: "x", value: 1, datatype: "int" }]);
      yield* assign(session, [{ name: "x", value: 2, datatype: "int" }]);

      Vitest.expect(yield* Fiber.join(count)).toBe(3);
    }),
  );

  it.effect(
    "preserves variable values when updating variable declarations",
    Effect.fn(function* () {
      const session = yield* open();
      yield* assign(session, [
        { name: "x", value: 42, datatype: "int" },
        { name: "y", value: "hello", datatype: "str" },
        { name: "z", value: 3.14, datatype: "float" },
      ]);
      yield* declare(session, [
        { name: "x", declared_by: ["cell1"], used_by: ["cell2"] },
        { name: "y", declared_by: ["cell2"], used_by: [] },
      ]);

      const values = Option.getOrThrow((yield* current()).values);
      Vitest.expect(values).toEqual([
        Vitest.expect.objectContaining({ name: "x", value: 42 }),
        Vitest.expect.objectContaining({ name: "y", value: "hello" }),
      ]);
    }),
  );
});
