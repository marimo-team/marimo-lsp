import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";

import { createTestNotebookDocument, Uri } from "../../__mocks__/TestVsCode.ts";
import { makeTestNotebookDocumentSession } from "../../__tests__/__utils__/TestNotebookDocumentSession.ts";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import {
  type NotebookDocumentSession,
  NotebookDocumentSessions,
} from "../../notebook/NotebookDocumentSessions.ts";
import { NotebookVariables } from "../../panel/variables/NotebookVariables.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
  type NotebookId,
} from "../../schemas/MarimoNotebookDocument.ts";
import type { VariablesNotification } from "../../types.ts";
import { getTopologicalCells } from "../getTopologicalCells.ts";
import { cellId, variableName } from "./branded.ts";

function createMockVariablesOp(
  vars: Array<{
    declared_by: Array<string>;
    name: string;
    used_by: Array<string>;
  }>,
): VariablesNotification {
  return {
    op: "variables",
    variables: vars.map((v) => ({
      declared_by: v.declared_by.map(cellId),
      name: variableName(v.name),
      used_by: v.used_by.map(cellId),
    })),
  };
}

function makeNotebookWithCells(
  cellConfigs: Array<{ stableId: string; code: string }>,
) {
  const uri = Uri.file("/test/notebook.py");
  const cells = cellConfigs.map((config) => ({
    kind: 2 as const, // Code cell
    value: config.code,
    languageId: "mo-python",
    metadata: MarimoNotebookCell.createMetadata({
      marimoRuntime: { stableId: config.stableId },
    }),
  }));

  const raw = createTestNotebookDocument(uri, {
    notebookType: NOTEBOOK_TYPE,
    data: { cells, metadata: {} },
  });

  return MarimoNotebookDocument.from(raw);
}

const sessions = new Map<NotebookId, NotebookDocumentSession>();
const documentSessions = Layer.succeed(NotebookDocumentSessions, {
  current: (id: NotebookId) => Option.fromNullishOr(sessions.get(id)),
  forDocument: (document) =>
    Option.fromNullishOr(
      Array.from(sessions.values()).find(
        (session) => session.document === document,
      ),
    ),
  active: Stream.empty,
});
const withTestLayer = () =>
  Layer.effect(NotebookVariables, NotebookVariables.make).pipe(
    Layer.provide(documentSessions),
  );

const stableId = (cell: { metadata?: unknown }) =>
  Option.getOrUndefined(MarimoNotebookCell.decodeMetadata(cell.metadata))
    ?.marimoRuntime.stableId ?? undefined;

const sessionFor = (notebook: MarimoNotebookDocument) => {
  const current = sessions.get(notebook.id);
  if (current?.document === notebook.rawNotebookDocument) return current;
  const session = makeTestNotebookDocumentSession(notebook.rawNotebookDocument);
  sessions.set(notebook.id, session);
  return session;
};

describe("getTopologicalCells", () => {
  it.effect("returns empty array for notebook with no cells", () =>
    Effect.gen(function* () {
      const doc = makeNotebookWithCells([]);

      const result = yield* getTopologicalCells(doc);

      expect(result).toEqual([]);
    }).pipe(Effect.provide(withTestLayer())),
  );

  it.effect(
    "returns cells in document order when no variables are available",
    () =>
      Effect.gen(function* () {
        const doc = makeNotebookWithCells([
          { stableId: "cell-a", code: "x = 1" },
          { stableId: "cell-b", code: "y = 2" },
          { stableId: "cell-c", code: "z = 3" },
        ]);

        const result = yield* getTopologicalCells(doc);

        expect(result.length).toBe(3);
        // Document order since no variables registered
        expect(stableId(result[0])).toBe("cell-a");
        expect(stableId(result[1])).toBe("cell-b");
        expect(stableId(result[2])).toBe("cell-c");
      }).pipe(Effect.provide(withTestLayer())),
  );

  it.effect("reorders cells based on variable dependencies", () =>
    Effect.gen(function* () {
      const doc = makeNotebookWithCells([
        { stableId: "cell-b", code: "y = x + 1" }, // uses x
        { stableId: "cell-a", code: "x = 1" }, // defines x
      ]);

      const service = yield* NotebookVariables;

      yield* service.updateVariables(
        sessionFor(doc),
        createMockVariablesOp([
          { name: "x", declared_by: ["cell-a"], used_by: ["cell-b"] },
        ]),
      );

      const result = yield* getTopologicalCells(doc);

      expect(result.length).toBe(2);
      // cell-a should come before cell-b because cell-a defines x which cell-b uses
      expect(stableId(result[0])).toBe("cell-a");
      expect(stableId(result[1])).toBe("cell-b");
    }).pipe(Effect.provide(withTestLayer())),
  );

  it.effect("handles chain of dependencies", () =>
    Effect.gen(function* () {
      // Document order: C, B, A
      // Dependency: A -> B -> C (A defines x, B uses x and defines y, C uses y)
      const doc = makeNotebookWithCells([
        { stableId: "cell-c", code: "z = y + 1" }, // uses y
        { stableId: "cell-b", code: "y = x + 1" }, // uses x, defines y
        { stableId: "cell-a", code: "x = 1" }, // defines x
      ]);

      const service = yield* NotebookVariables;

      yield* service.updateVariables(
        sessionFor(doc),
        createMockVariablesOp([
          { name: "x", declared_by: ["cell-a"], used_by: ["cell-b"] },
          { name: "y", declared_by: ["cell-b"], used_by: ["cell-c"] },
        ]),
      );

      const result = yield* getTopologicalCells(doc);

      expect(result.length).toBe(3);
      // Should be topologically sorted: A, B, C
      expect(stableId(result[0])).toBe("cell-a");
      expect(stableId(result[1])).toBe("cell-b");
      expect(stableId(result[2])).toBe("cell-c");
    }).pipe(Effect.provide(withTestLayer())),
  );

  it.effect("places cells without stableId at the end", () =>
    Effect.gen(function* () {
      const uri = Uri.file("/test/notebook.py");
      const raw = createTestNotebookDocument(uri, {
        notebookType: NOTEBOOK_TYPE,
        data: {
          cells: [
            {
              kind: 2,
              value: "y = x",
              languageId: "mo-python",
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "cell-b" },
              }),
            },
            {
              kind: 2,
              value: "# no id",
              languageId: "mo-python",
              metadata: MarimoNotebookCell.createMetadata({}), // no stableId
            },
            {
              kind: 2,
              value: "x = 1",
              languageId: "mo-python",
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "cell-a" },
              }),
            },
          ],
          metadata: {},
        },
      });
      const doc = MarimoNotebookDocument.from(raw);

      const service = yield* NotebookVariables;

      yield* service.updateVariables(
        sessionFor(doc),
        createMockVariablesOp([
          { name: "x", declared_by: ["cell-a"], used_by: ["cell-b"] },
        ]),
      );

      const result = yield* getTopologicalCells(doc);

      expect(result.length).toBe(3);
      // cell-a first (defines x), cell-b second (uses x), cell without id last
      expect(stableId(result[0])).toBe("cell-a");
      expect(stableId(result[1])).toBe("cell-b");
      expect(stableId(result[2])).toBeUndefined();
    }).pipe(Effect.provide(withTestLayer())),
  );

  it.effect("handles independent cells (no shared variables)", () =>
    Effect.gen(function* () {
      const doc = makeNotebookWithCells([
        { stableId: "cell-a", code: "x = 1" },
        { stableId: "cell-b", code: "y = 2" },
        { stableId: "cell-c", code: "z = 3" },
      ]);

      const service = yield* NotebookVariables;

      // Each cell defines its own variable, no cross-cell dependencies
      yield* service.updateVariables(
        sessionFor(doc),
        createMockVariablesOp([
          { name: "x", declared_by: ["cell-a"], used_by: [] },
          { name: "y", declared_by: ["cell-b"], used_by: [] },
          { name: "z", declared_by: ["cell-c"], used_by: [] },
        ]),
      );

      const result = yield* getTopologicalCells(doc);

      // All cells are independent, so they should all be present
      // Order is determined by getTopologicalCellIds (cells with no deps go to end)
      expect(result.length).toBe(3);
      const stableIds = result.map(stableId);
      expect(stableIds).toContain("cell-a");
      expect(stableIds).toContain("cell-b");
      expect(stableIds).toContain("cell-c");
    }).pipe(Effect.provide(withTestLayer())),
  );

  it.effect("handles diamond dependency pattern", () =>
    Effect.gen(function* () {
      // Diamond: A defines x, B and C both use x, D uses variables from B and C
      const doc = makeNotebookWithCells([
        { stableId: "cell-d", code: "w = y + z" },
        { stableId: "cell-c", code: "z = x + 2" },
        { stableId: "cell-b", code: "y = x + 1" },
        { stableId: "cell-a", code: "x = 1" },
      ]);

      const service = yield* NotebookVariables;

      yield* service.updateVariables(
        sessionFor(doc),
        createMockVariablesOp([
          {
            name: "x",
            declared_by: ["cell-a"],
            used_by: ["cell-b", "cell-c"],
          },
          { name: "y", declared_by: ["cell-b"], used_by: ["cell-d"] },
          { name: "z", declared_by: ["cell-c"], used_by: ["cell-d"] },
        ]),
      );

      const result = yield* getTopologicalCells(doc);

      expect(result.length).toBe(4);

      const stableIds = result.map(stableId);
      const indexA = stableIds.indexOf("cell-a");
      const indexB = stableIds.indexOf("cell-b");
      const indexC = stableIds.indexOf("cell-c");
      const indexD = stableIds.indexOf("cell-d");

      // A must come before B and C
      expect(indexA).toBeLessThan(indexB);
      expect(indexA).toBeLessThan(indexC);
      // B and C must come before D
      expect(indexB).toBeLessThan(indexD);
      expect(indexC).toBeLessThan(indexD);
    }).pipe(Effect.provide(withTestLayer())),
  );

  it.effect("filters out non-Python cells (SQL, markdown)", () =>
    Effect.gen(function* () {
      const uri = Uri.file("/test/notebook.py");
      const raw = createTestNotebookDocument(uri, {
        notebookType: NOTEBOOK_TYPE,
        data: {
          cells: [
            {
              kind: 2,
              value: "x = 1",
              languageId: "mo-python",
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "python-1" },
              }),
            },
            {
              kind: 2,
              value: "SELECT * FROM table",
              languageId: "sql",
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "sql-1" },
              }),
            },
            {
              kind: 2,
              value: "y = x + 1",
              languageId: "mo-python",
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "python-2" },
              }),
            },
            {
              kind: 1, // Markup cell
              value: "# Header",
              languageId: "markdown",
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "markdown-1" },
              }),
            },
            {
              kind: 2,
              value: "z = y + 1",
              languageId: "python", // Also accept plain "python"
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "python-3" },
              }),
            },
          ],
          metadata: {},
        },
      });
      const doc = MarimoNotebookDocument.from(raw);
      const result = yield* getTopologicalCells(doc);

      expect(result.map(stableId)).toEqual([
        "python-1",
        "python-2",
        "python-3",
      ]);
    }).pipe(Effect.provide(withTestLayer())),
  );
});
