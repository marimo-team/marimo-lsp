import * as Vitest from "@effect/vitest";
import { Effect, Option } from "effect";

import * as VsCodeTest from "../../__tests__/fake/VsCode.ts";
import * as EffectTest from "../../__tests__/lib/EffectTest.ts";
import * as VsCode from "../../platform/VsCode.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import * as CellMetadata from "../CellMetadata.ts";

const it = EffectTest.make(VsCodeTest.layer);
const rejectingIt = EffectTest.make(
  VsCodeTest.layerWith(
    {},
    {
      workspace: { applyEdit: () => Effect.succeed(false) },
    },
  ),
);

const latestWorkspaceEdit = Effect.fn(function* () {
  const vscode = yield* VsCodeTest.Service;
  return Option.fromNullishOr((yield* vscode.snapshot).workspaceEdits.at(-1));
});

it.effect(
  "replaces metadata while preserving cell content, outputs, and runtime state",
  Effect.fn(function* () {
    const code = yield* VsCode.Service;
    const uri = VsCodeTest.createNotebookUri("file:///test/notebook_mo.py");
    const output = new code.NotebookCellOutput([
      code.NotebookCellOutputItem.text("result"),
    ]);
    const executionSummary = {
      executionOrder: 7,
      success: true,
    };
    const metadata = {
      ...MarimoNotebookCell.createMetadata({
        marimo: {
          name: "cell_name",
          options: { disabled: true },
        },
        marimoRuntime: { stableId: "cell-1", state: "stale" },
      }),
      foreign: { ownedBy: "another-extension" },
    };
    const document = VsCodeTest.createTestNotebookDocument(uri, {
      data: {
        cells: [
          { kind: 2, value: "a = 0", languageId: "mo-python" },
          { kind: 2, value: "b = 0", languageId: "mo-python" },
          {
            kind: 2,
            value: "x = 1",
            languageId: "mo-python",
            metadata,
            outputs: [output],
            executionSummary,
          },
        ],
      },
    });
    const cell = MarimoNotebookCell.from(document.cellAt(2));

    yield* CellMetadata.update(cell, (current) => ({
      ...current,
      options: { ...current.options, hide_code: true },
    }));

    const workspaceEdit = Option.getOrThrow(yield* latestWorkspaceEdit());
    const notebookEdits = VsCodeTest.getNotebookEdits(workspaceEdit, uri);
    Vitest.expect(notebookEdits).toHaveLength(1);
    Vitest.expect(notebookEdits[0]?.range).toMatchObject({ start: 2, end: 3 });

    const replacement = notebookEdits[0]?.newCells[0];
    Vitest.expect(replacement).toMatchObject({
      kind: 2,
      value: "x = 1",
      languageId: "mo-python",
      executionSummary,
    });
    Vitest.expect(replacement?.outputs).toHaveLength(1);
    Vitest.expect(replacement?.outputs?.[0]).not.toBe(output);
    Vitest.expect(replacement?.outputs?.[0]?.items[0]).not.toBe(
      output.items[0],
    );
    Vitest.expect(replacement?.outputs?.[0]).toEqual(output);
    const decoded = Option.getOrThrow(
      MarimoNotebookCell.decodeMetadata(replacement?.metadata),
    );
    Vitest.expect(decoded.marimo).toMatchObject({
      name: "cell_name",
      options: { disabled: true, hide_code: true },
    });
    Vitest.expect(decoded.marimoRuntime).toEqual({
      stableId: "cell-1",
      state: "stale",
    });
    Vitest.expect(replacement?.metadata).toMatchObject({
      foreign: { ownedBy: "another-extension" },
    });
  }),
);

it.effect(
  "uses metadata defaults for a cell without metadata",
  Effect.fn(function* () {
    const uri = VsCodeTest.createNotebookUri("file:///test/notebook_mo.py");
    const document = VsCodeTest.createTestNotebookDocument(uri, {
      data: {
        cells: [{ kind: 2, value: "x = 1", languageId: "mo-python" }],
      },
    });
    const cell = MarimoNotebookCell.from(document.cellAt(0));

    yield* CellMetadata.update(cell, (current) => ({
      ...current,
      options: { ...current.options, hide_code: true },
    }));

    const workspaceEdit = Option.getOrThrow(yield* latestWorkspaceEdit());
    const replacement = VsCodeTest.getNotebookEdits(workspaceEdit, uri)[0]
      ?.newCells[0];
    const decoded = Option.getOrThrow(
      MarimoNotebookCell.decodeMetadata(replacement?.metadata),
    );
    Vitest.expect(decoded.marimo.options.hide_code).toBe(true);
  }),
);

rejectingIt.effect(
  "fails when VS Code rejects the metadata edit",
  Effect.fn(function* () {
    const document = VsCodeTest.createTestNotebookDocument(
      "/test/notebook_mo.py",
      {
        data: {
          cells: [{ kind: 2, value: "x = 1", languageId: "mo-python" }],
        },
      },
    );
    const cell = MarimoNotebookCell.from(document.cellAt(0));

    const error = yield* CellMetadata.update(cell, (metadata) => metadata).pipe(
      Effect.flip,
    );

    Vitest.expect(error).toEqual(new CellMetadata.EditRejected({ cell: 0 }));
  }),
);

it.effect(
  "resolves a stale cell handle by stable ID",
  Effect.fn(function* () {
    const uri = VsCodeTest.createNotebookUri("file:///test/notebook_mo.py");
    const document = VsCodeTest.createTestNotebookDocument(uri, {
      data: {
        cells: [
          { kind: 2, value: "other = 0", languageId: "mo-python" },
          {
            kind: 2,
            value: "latest = 2",
            languageId: "mo-python",
            metadata: MarimoNotebookCell.createMetadata({
              marimo: { options: { disabled: true, hide_code: false } },
              marimoRuntime: { stableId: "target" },
            }),
          },
        ],
      },
    });
    const stale = MarimoNotebookCell.from(
      VsCodeTest.createNotebookCell(
        document,
        {
          kind: 2,
          value: "stale = 1",
          languageId: "mo-python",
          metadata: MarimoNotebookCell.createMetadata({
            marimo: { options: { disabled: false, hide_code: false } },
            marimoRuntime: { stableId: "target" },
          }),
        },
        0,
      ),
    );
    Vitest.expect(Option.isSome(stale.metadata)).toBe(true);

    yield* CellMetadata.update(stale, (current) => ({
      ...current,
      options: { ...current.options, hide_code: true },
    }));

    const workspaceEdit = Option.getOrThrow(yield* latestWorkspaceEdit());
    const notebookEdit = VsCodeTest.getNotebookEdits(workspaceEdit, uri)[0];
    Vitest.expect(notebookEdit?.range).toMatchObject({ start: 1, end: 2 });
    Vitest.expect(notebookEdit?.newCells[0]?.value).toBe("latest = 2");
    const decoded = Option.getOrThrow(
      MarimoNotebookCell.decodeMetadata(notebookEdit?.newCells[0]?.metadata),
    );
    Vitest.expect(decoded.marimo.options).toMatchObject({
      disabled: true,
      hide_code: true,
    });
  }),
);

it.effect(
  "rejects a stale cell handle whose target is gone",
  Effect.fn(function* () {
    const vscode = yield* VsCodeTest.Service;
    const document = VsCodeTest.createTestNotebookDocument(
      "/test/notebook_mo.py",
      {
        data: {
          cells: [{ kind: 2, value: "other = 0", languageId: "mo-python" }],
        },
      },
    );
    const stale = MarimoNotebookCell.from(
      VsCodeTest.createNotebookCell(
        document,
        {
          kind: 2,
          value: "deleted = 1",
          languageId: "mo-python",
          metadata: MarimoNotebookCell.createMetadata({
            marimoRuntime: { stableId: "deleted" },
          }),
        },
        0,
      ),
    );

    const error = yield* CellMetadata.update(
      stale,
      (metadata) => metadata,
    ).pipe(Effect.flip);

    Vitest.expect(error).toEqual(new CellMetadata.TargetNotFound({ cell: 0 }));
    Vitest.expect((yield* vscode.snapshot).workspaceEdits).toEqual([]);
  }),
);
