import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Result } from "effect";

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
  it.each([
    { kind: 1 as const, hideCode: undefined, expected: true },
    { kind: 1 as const, hideCode: false, expected: false },
    { kind: 2 as const, hideCode: undefined, expected: false },
    { kind: 2 as const, hideCode: true, expected: true },
  ])(
    "defaults hide_code by cell kind: $kind/$hideCode -> $expected",
    ({ kind, hideCode, expected }) => {
      const rawCell = createNotebookCell(
        createTestNotebookDocument("file:///test/notebook_mo.py"),
        {
          kind,
          value: "",
          languageId: kind === 1 ? "markdown" : "python",
          metadata: MarimoNotebookCell.createMetadata({
            marimo: { options: { hide_code: hideCode } },
          }),
        },
        0,
      );

      expect(MarimoNotebookCell.from(rawCell).isCodeHidden).toBe(expected);
    },
  );

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
        Result.isFailure(
          Effect.runSync(Effect.result(notebook.parseMetadata())),
        ),
      ).toBe(true);
    },
  );
});

describe("MarimoNotebookDocument app config", () => {
  it("validates owned options and preserves options it does not understand", () => {
    const raw = createTestNotebookDocument("file:///test/notebook_mo.py", {
      data: {
        cells: [],
        metadata: {
          marimo: {
            appConfig: {
              auto_download: ["html", "future-format"],
              width: "wide",
              future_setting: { answer: 42 },
            },
          },
        },
      },
    });

    const parsed = Effect.runSync(
      MarimoNotebookDocument.from(raw).parseMetadata(),
    );
    expect(parsed.appConfig.auto_download).toEqual(["html", "future-format"]);
    expect(parsed.appConfig).toMatchObject({
      width: "wide",
      future_setting: { answer: 42 },
    });
  });

  it("rejects invalid values for the option owned by the extension", () => {
    const raw = createTestNotebookDocument("file:///test/notebook_mo.py", {
      data: {
        cells: [],
        metadata: {
          marimo: { appConfig: { auto_download: [42] } },
        },
      },
    });

    const result = Effect.runSync(
      Effect.result(MarimoNotebookDocument.from(raw).parseMetadata()),
    );
    expect(Result.isFailure(result)).toBe(true);
  });
});
