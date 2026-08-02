import { describe, expect, it } from "@effect/vitest";
import { Effect, Either, Option } from "effect";

import {
  createNotebookCell,
  createNotebookUri,
  createTestNotebookDocument,
} from "../../__mocks__/TestVsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../MarimoNotebookDocument.ts";

type MarimoUpdate = Parameters<
  MarimoNotebookCell["buildMarimoMetadataUpdate"]
>[0];

// @ts-expect-error -- updates require the complete decoded model, not a wire patch
const partialUpdate: MarimoUpdate = { name: "renamed" };
void partialUpdate;

describe("MarimoNotebookCell metadata updates", () => {
  it("replaces complete persisted metadata while preserving runtime and foreign fields", () => {
    const metadata = {
      ...MarimoNotebookCell.createMetadata({
        marimo: {
          name: "original",
          options: { disabled: true },
          sourceProjections: {
            markdown: { quotePrefix: "rf" },
            sql: null,
          },
        },
        marimoRuntime: { stableId: "cell-1", state: "stale" },
      }),
      foreign: { ownedBy: "another-extension" },
    };
    const rawCell = createNotebookCell(
      createTestNotebookDocument(
        createNotebookUri("file:///test/notebook_mo.py"),
      ),
      { kind: 2, value: "x = 1", languageId: "python", metadata },
      0,
    );
    const cell = MarimoNotebookCell.from(rawCell);
    const current = Option.getOrThrow(cell.metadata);

    const updated = cell.buildMarimoMetadataUpdate({
      ...current.marimo,
      name: "renamed",
    });
    const decoded = Option.getOrThrow(
      MarimoNotebookCell.decodeMetadata(updated),
    );

    expect(decoded.marimo).toEqual({
      ...current.marimo,
      name: "renamed",
    });
    expect(decoded.marimoRuntime).toEqual(current.marimoRuntime);
    expect(updated).toMatchObject({
      foreign: { ownedBy: "another-extension" },
    });
  });

  it.each([{ misspelled: true }, null])(
    "surfaces invalid notebook metadata to persistence operations",
    (marimo) => {
      const raw = createTestNotebookDocument("file:///test/notebook_mo.py", {
        data: {
          cells: [],
          metadata: { marimo },
        },
      });
      const notebook = MarimoNotebookDocument.from(raw);

      expect(
        Either.isLeft(Effect.runSync(Effect.either(notebook.parseMetadata()))),
      ).toBe(true);
    },
  );
});
