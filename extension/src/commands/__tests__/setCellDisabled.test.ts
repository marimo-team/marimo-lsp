import { expect } from "@effect/vitest";
import { Effect, Option } from "effect";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import disableCell from "../disableCell.ts";
import enableCell from "../enableCell.ts";

const it = EffectTest.make(TestVsCode.layer);

it.effect.each([
  { initial: false, command: disableCell, expected: true },
  { initial: true, command: enableCell, expected: false },
])("sets disabled=$expected", ({ initial, command, expected }) =>
  Effect.gen(function* () {
    const vscode = yield* TestVsCode.Service;
    const uri = TestVsCode.createNotebookUri("file:///test/notebook_mo.py");
    const document = TestVsCode.createTestNotebookDocument(uri, {
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
    const replacement = TestVsCode.getNotebookEdits(workspaceEdit, uri)[0]
      ?.newCells[0];
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
    const vscode = yield* TestVsCode.Service;
    const uri = TestVsCode.createNotebookUri("file:///test/notebook_mo.py");
    const document = TestVsCode.createTestNotebookDocument(uri, {
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

    expect((yield* vscode.snapshot).workspaceEdits).toEqual([]);
  }),
);
