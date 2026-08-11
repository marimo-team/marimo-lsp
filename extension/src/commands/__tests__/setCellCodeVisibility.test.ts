import { expect, it } from "@effect/vitest";
import { Effect, Option, Ref } from "effect";
import type * as vscode from "vscode";

import {
  createNotebookUri,
  createTestNotebookDocument,
  getNotebookEdits,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import hideCellCode from "../hideCellCode.ts";
import showCellCode from "../showCellCode.ts";

it.effect.each([
  {
    hidden: true,
    command: "notebook.cell.collapseCellInput" as const,
  },
  {
    hidden: false,
    command: "notebook.cell.expandCellInput" as const,
  },
])("persists and applies hide_code=$hidden", ({ hidden, command }) =>
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
            value: "x = 1",
            languageId: "mo-python",
            metadata: MarimoNotebookCell.createMetadata({
              marimo: { options: { hide_code: !hidden } },
              marimoRuntime: { stableId: "cell-1" },
            }),
          },
        ],
      },
    });
    const rawCell = document.cellAt(1);

    const invoke = hidden ? hideCellCode.invoke : showCellCode.invoke;
    yield* invoke(Option.some(MarimoNotebookCell.from(rawCell))).pipe(
      Effect.provide(vscode.layer),
    );

    const workspaceEdit = Option.getOrThrow(yield* Ref.get(applied));
    const replacement = getNotebookEdits(workspaceEdit, uri)[0]?.newCells[0];
    const metadata = Option.getOrThrow(
      MarimoNotebookCell.decodeMetadata(replacement?.metadata),
    );
    expect(metadata.marimo.options.hide_code).toBe(hidden);
    expect(yield* Ref.get(vscode.executions)).toEqual([
      {
        command,
        args: [
          {
            ranges: [{ start: 1, end: 2 }],
            document: uri,
          },
        ],
      },
    ]);
  }),
);

it.effect.each([
  { hidden: true, invoke: hideCellCode.invoke },
  { hidden: false, invoke: showCellCode.invoke },
])("persists markup hide_code=$hidden while keeping input expanded", (test) =>
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
          {
            kind: 1,
            value: "# Markdown",
            languageId: "markdown",
            metadata: MarimoNotebookCell.createMetadata({
              marimo: { options: { hide_code: !test.hidden } },
              marimoRuntime: { stableId: "markdown" },
            }),
          },
        ],
      },
    });
    const cell = Option.some(MarimoNotebookCell.from(document.cellAt(0)));

    yield* test.invoke(cell).pipe(Effect.provide(vscode.layer));

    const workspaceEdit = Option.getOrThrow(yield* Ref.get(applied));
    const replacement = getNotebookEdits(workspaceEdit, uri)[0]?.newCells[0];
    const metadata = Option.getOrThrow(
      MarimoNotebookCell.decodeMetadata(replacement?.metadata),
    );
    expect(metadata.marimo.options.hide_code).toBe(test.hidden);
    expect(yield* Ref.get(vscode.executions)).toEqual([
      {
        command: "notebook.cell.expandCellInput",
        args: [
          {
            ranges: [{ start: 0, end: 1 }],
            document: uri,
          },
        ],
      },
    ]);
  }),
);
