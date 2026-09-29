import * as Vitest from "@effect/vitest";
import { Effect, Option } from "effect";

import * as VsCodeTest from "../../__tests__/fake/VsCode.ts";
import * as EffectTest from "../../__tests__/lib/EffectTest.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import hideCellCode from "../hideCellCode.ts";
import showCellCode from "../showCellCode.ts";

const it = EffectTest.make(VsCodeTest.layer);

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
    const vscode = yield* VsCodeTest.Service;
    const uri = VsCodeTest.createNotebookUri("file:///test/notebook_mo.py");
    const document = VsCodeTest.createTestNotebookDocument(uri, {
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
    yield* invoke(Option.some(MarimoNotebookCell.from(rawCell)));

    const snapshot = yield* vscode.snapshot;
    const workspaceEdit = Option.getOrThrow(
      Option.fromNullishOr(snapshot.workspaceEdits.at(-1)),
    );
    const replacement = VsCodeTest.getNotebookEdits(workspaceEdit, uri)[0]
      ?.newCells[0];
    const metadata = Option.getOrThrow(
      MarimoNotebookCell.decodeMetadata(replacement?.metadata),
    );
    Vitest.expect(metadata.marimo.options.hide_code).toBe(hidden);
    Vitest.expect(snapshot.executions).toEqual([
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
    const vscode = yield* VsCodeTest.Service;
    const uri = VsCodeTest.createNotebookUri("file:///test/notebook_mo.py");
    const document = VsCodeTest.createTestNotebookDocument(uri, {
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

    yield* test.invoke(cell);

    const snapshot = yield* vscode.snapshot;
    const workspaceEdit = Option.getOrThrow(
      Option.fromNullishOr(snapshot.workspaceEdits.at(-1)),
    );
    const replacement = VsCodeTest.getNotebookEdits(workspaceEdit, uri)[0]
      ?.newCells[0];
    const metadata = Option.getOrThrow(
      MarimoNotebookCell.decodeMetadata(replacement?.metadata),
    );
    Vitest.expect(metadata.marimo.options.hide_code).toBe(test.hidden);
    Vitest.expect(snapshot.executions).toEqual([
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
