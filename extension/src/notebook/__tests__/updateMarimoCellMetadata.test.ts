import { expect, it } from "@effect/vitest";
import { Effect, Option, Ref } from "effect";
import type * as vscode from "vscode";

import {
  createNotebookCell,
  createNotebookUri,
  createTestNotebookDocument,
  getNotebookEdits,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { VsCode } from "../../platform/VsCode.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import {
  CellMetadataEditRejected,
  CellMetadataTargetNotFound,
  updateMarimoCellMetadata,
} from "../updateMarimoCellMetadata.ts";

it.effect(
  "replaces metadata while preserving cell content, outputs, and runtime state",
  () =>
    Effect.gen(function* () {
      const applied = yield* Ref.make(Option.none<vscode.WorkspaceEdit>());
      const vscode = yield* TestVsCode.make({
        workspace: {
          applyEdit: (edit) =>
            Ref.set(applied, Option.some(edit)).pipe(Effect.as(true)),
        },
      });

      yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const uri = createNotebookUri("file:///test/notebook_mo.py");
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
        const document = createTestNotebookDocument(uri, {
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

        yield* updateMarimoCellMetadata(cell, (current) => ({
          ...current,
          options: { ...current.options, hide_code: true },
        }));

        const workspaceEdit = Option.getOrThrow(yield* Ref.get(applied));
        const notebookEdits = getNotebookEdits(workspaceEdit, uri);
        expect(notebookEdits).toHaveLength(1);
        expect(notebookEdits[0]?.range).toMatchObject({ start: 2, end: 3 });

        const replacement = notebookEdits[0]?.newCells[0];
        expect(replacement).toMatchObject({
          kind: 2,
          value: "x = 1",
          languageId: "mo-python",
          executionSummary,
        });
        expect(replacement?.outputs).toHaveLength(1);
        expect(replacement?.outputs?.[0]).not.toBe(output);
        expect(replacement?.outputs?.[0]?.items[0]).not.toBe(output.items[0]);
        expect(replacement?.outputs?.[0]).toEqual(output);
        const decoded = Option.getOrThrow(
          MarimoNotebookCell.decodeMetadata(replacement?.metadata),
        );
        expect(decoded.marimo).toMatchObject({
          name: "cell_name",
          options: { disabled: true, hide_code: true },
        });
        expect(decoded.marimoRuntime).toEqual({
          stableId: "cell-1",
          state: "stale",
        });
        expect(replacement?.metadata).toMatchObject({
          foreign: { ownedBy: "another-extension" },
        });
      }).pipe(Effect.provide(vscode.layer));
    }),
);

it.effect("uses metadata defaults for a cell without metadata", () =>
  Effect.gen(function* () {
    const applied = yield* Ref.make(Option.none<vscode.WorkspaceEdit>());
    const vscode = yield* TestVsCode.make({
      workspace: {
        applyEdit: (edit) =>
          Ref.set(applied, Option.some(edit)).pipe(Effect.as(true)),
      },
    });
    const uri = createNotebookUri("file:///test/notebook_mo.py");
    const document = createTestNotebookDocument(uri, {
      data: {
        cells: [{ kind: 2, value: "x = 1", languageId: "mo-python" }],
      },
    });
    const cell = MarimoNotebookCell.from(document.cellAt(0));

    yield* updateMarimoCellMetadata(cell, (current) => ({
      ...current,
      options: { ...current.options, hide_code: true },
    })).pipe(Effect.provide(vscode.layer));

    const workspaceEdit = Option.getOrThrow(yield* Ref.get(applied));
    const replacement = getNotebookEdits(workspaceEdit, uri)[0]?.newCells[0];
    const decoded = Option.getOrThrow(
      MarimoNotebookCell.decodeMetadata(replacement?.metadata),
    );
    expect(decoded.marimo.options.hide_code).toBe(true);
  }),
);

it.effect("fails when VS Code rejects the metadata edit", () =>
  Effect.gen(function* () {
    const vscode = yield* TestVsCode.make({
      workspace: { applyEdit: () => Effect.succeed(false) },
    });
    const document = createTestNotebookDocument("/test/notebook_mo.py", {
      data: {
        cells: [{ kind: 2, value: "x = 1", languageId: "mo-python" }],
      },
    });
    const cell = MarimoNotebookCell.from(document.cellAt(0));

    const error = yield* updateMarimoCellMetadata(
      cell,
      (metadata) => metadata,
    ).pipe(Effect.provide(vscode.layer), Effect.flip);

    expect(error).toEqual(new CellMetadataEditRejected({ cell: 0 }));
  }),
);

it.effect("resolves a stale cell handle by stable ID", () =>
  Effect.gen(function* () {
    const applied = yield* Ref.make(Option.none<vscode.WorkspaceEdit>());
    const vscode = yield* TestVsCode.make({
      workspace: {
        applyEdit: (edit) =>
          Ref.set(applied, Option.some(edit)).pipe(Effect.as(true)),
      },
    });
    const uri = createNotebookUri("file:///test/notebook_mo.py");
    const document = createTestNotebookDocument(uri, {
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
      createNotebookCell(
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
    // Prime the stale wrapper's metadata cache before resolving the live cell.
    expect(Option.isSome(stale.metadata)).toBe(true);

    yield* updateMarimoCellMetadata(stale, (current) => ({
      ...current,
      options: { ...current.options, hide_code: true },
    })).pipe(Effect.provide(vscode.layer));

    const workspaceEdit = Option.getOrThrow(yield* Ref.get(applied));
    const notebookEdit = getNotebookEdits(workspaceEdit, uri)[0];
    expect(notebookEdit?.range).toMatchObject({ start: 1, end: 2 });
    expect(notebookEdit?.newCells[0]?.value).toBe("latest = 2");
    const decoded = Option.getOrThrow(
      MarimoNotebookCell.decodeMetadata(notebookEdit?.newCells[0]?.metadata),
    );
    expect(decoded.marimo.options).toMatchObject({
      disabled: true,
      hide_code: true,
    });
  }),
);

it.effect("rejects a stale cell handle whose target is gone", () =>
  Effect.gen(function* () {
    const applied = yield* Ref.make(false);
    const vscode = yield* TestVsCode.make({
      workspace: {
        applyEdit: () => Ref.set(applied, true).pipe(Effect.as(true)),
      },
    });
    const document = createTestNotebookDocument("/test/notebook_mo.py", {
      data: {
        cells: [{ kind: 2, value: "other = 0", languageId: "mo-python" }],
      },
    });
    const stale = MarimoNotebookCell.from(
      createNotebookCell(
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

    const error = yield* updateMarimoCellMetadata(
      stale,
      (metadata) => metadata,
    ).pipe(Effect.provide(vscode.layer), Effect.flip);

    expect(error).toEqual(new CellMetadataTargetNotFound({ cell: 0 }));
    expect(yield* Ref.get(applied)).toBe(false);
  }),
);
