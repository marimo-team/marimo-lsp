import * as Vitest from "@effect/vitest";
import { Effect, Option } from "effect";

import disableCell from "../../src/commands/disableCell.ts";
import enableCell from "../../src/commands/enableCell.ts";
import { MarimoNotebookCell } from "../../src/schemas/MarimoNotebookDocument.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as EffectTest from "../lib/EffectTest.ts";

const it = EffectTest.make(VsCodeTest.layer);

it.effect.each([
  { initial: false, command: disableCell, expected: true },
  { initial: true, command: enableCell, expected: false },
])("sets disabled=$expected", ({ initial, command, expected }) =>
  Effect.gen(function* () {
    const vscode = yield* VsCodeTest.Service;
    const uri = VsCodeTest.createNotebookUri("file:///test/notebook_mo.py");
    const document = VsCodeTest.createTestNotebookDocument(uri, {
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

    yield* command.invoke(
      Option.some(MarimoNotebookCell.from(document.cellAt(0))),
    );

    const workspaceEdit = Option.getOrThrow(
      Option.fromNullishOr((yield* vscode.snapshot).workspaceEdits.at(-1)),
    );
    const replacement = VsCodeTest.getNotebookEdits(workspaceEdit, uri)[0]
      ?.newCells[0];
    const metadata = Option.getOrThrow(
      MarimoNotebookCell.decodeMetadata(replacement?.metadata),
    );
    Vitest.expect(metadata.marimo.options).toMatchObject({
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
    const vscode = yield* VsCodeTest.Service;
    const uri = VsCodeTest.createNotebookUri("file:///test/notebook_mo.py");
    const document = VsCodeTest.createTestNotebookDocument(uri, {
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

    yield* disableCell.invoke(
      Option.some(MarimoNotebookCell.from(document.cellAt(0))),
    );

    Vitest.expect((yield* vscode.snapshot).workspaceEdits).toEqual([]);
  }),
);
