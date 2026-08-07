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
import disableCell from "../disableCell.ts";
import enableCell from "../enableCell.ts";

it.effect.each([
  { initial: false, command: disableCell, expected: true },
  { initial: true, command: enableCell, expected: false },
])("sets disabled=$expected", ({ initial, command, expected }) =>
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
            kind: 2,
            value: "x = 1",
            languageId: "mo-python",
            metadata: MarimoNotebookCell.createMetadata({
              marimo: { options: { disabled: initial, hide_code: true } },
              marimoRuntime: { stableId: "cell-1" },
            }),
          },
        ],
      },
    });

    yield* command
      .invoke(Option.some(MarimoNotebookCell.from(document.cellAt(0))))
      .pipe(Effect.provide(vscode.layer));

    const workspaceEdit = Option.getOrThrow(yield* Ref.get(applied));
    const replacement = getNotebookEdits(workspaceEdit, uri)[0]?.newCells[0];
    const metadata = Option.getOrThrow(
      MarimoNotebookCell.decodeMetadata(replacement?.metadata),
    );
    expect(metadata.marimo.options).toMatchObject({
      disabled: expected,
      hide_code: true,
    });
  }),
);

it.effect.each([
  { marimo: { name: "setup" } },
  { marimoRuntime: { stableId: "setup" } },
])("does not disable the setup cell identified by metadata", (metadata) =>
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
            kind: 2,
            value: "x = 1",
            languageId: "mo-python",
            metadata: MarimoNotebookCell.createMetadata(metadata),
          },
        ],
      },
    });

    yield* disableCell
      .invoke(Option.some(MarimoNotebookCell.from(document.cellAt(0))))
      .pipe(Effect.provide(vscode.layer));

    expect(Option.isNone(yield* Ref.get(applied))).toBe(true);
  }),
);
