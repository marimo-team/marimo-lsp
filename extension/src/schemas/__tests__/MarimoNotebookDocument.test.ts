import * as Vitest from "@effect/vitest";
import { Effect, Option, Result } from "effect";

import * as VsCodeTest from "../../__tests__/fake/VsCode.ts";
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

Vitest.describe("MarimoNotebookCell metadata updates", () => {
  Vitest.it.each([
    { kind: 1 as const, hideCode: undefined, expected: true },
    { kind: 1 as const, hideCode: false, expected: false },
    { kind: 2 as const, hideCode: undefined, expected: false },
    { kind: 2 as const, hideCode: true, expected: true },
  ])(
    "defaults hide_code by cell kind: $kind/$hideCode -> $expected",
    ({ kind, hideCode, expected }) => {
      const rawCell = VsCodeTest.createNotebookCell(
        VsCodeTest.createTestNotebookDocument("file:///test/notebook_mo.py"),
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

      Vitest.expect(MarimoNotebookCell.from(rawCell).isCodeHidden).toBe(
        expected,
      );
    },
  );

  Vitest.it(
    "replaces complete persisted metadata while preserving runtime and foreign fields",
    () => {
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
      const rawCell = VsCodeTest.createNotebookCell(
        VsCodeTest.createTestNotebookDocument(
          VsCodeTest.createNotebookUri("file:///test/notebook_mo.py"),
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

      Vitest.expect(decoded.marimo).toEqual({
        ...current.marimo,
        name: "renamed",
      });
      Vitest.expect(decoded.marimoRuntime).toEqual(current.marimoRuntime);
      Vitest.expect(updated).toMatchObject({
        foreign: { ownedBy: "another-extension" },
      });
    },
  );

  Vitest.it.each([{ misspelled: true }, null])(
    "surfaces invalid notebook metadata to persistence operations",
    (marimo) => {
      const raw = VsCodeTest.createTestNotebookDocument(
        "file:///test/notebook_mo.py",
        {
          data: {
            cells: [],
            metadata: { marimo },
          },
        },
      );
      const notebook = MarimoNotebookDocument.from(raw);

      Vitest.expect(
        Result.isFailure(
          Effect.runSync(Effect.result(notebook.parseMetadata())),
        ),
      ).toBe(true);
    },
  );
});

Vitest.describe("MarimoNotebookDocument app options", () => {
  Vitest.it(
    "validates managed options and preserves passthrough options",
    () => {
      const raw = VsCodeTest.createTestNotebookDocument(
        "file:///test/notebook_mo.py",
        {
          data: {
            cells: [],
            metadata: {
              marimo: {
                appOptions: {
                  managed: { autoDownload: ["html", "future-format"] },
                  passthrough: {
                    width: "wide",
                    future_setting: { answer: 42 },
                  },
                },
              },
            },
          },
        },
      );

      const parsed = Effect.runSync(
        MarimoNotebookDocument.from(raw).parseMetadata(),
      );
      Vitest.expect(parsed.appOptions).toMatchInlineSnapshot(`
      {
        "managed": {
          "autoDownload": [
            "html",
            "future-format",
          ],
        },
        "passthrough": {
          "future_setting": {
            "answer": 42,
          },
          "width": "wide",
        },
      }
    `);
    },
  );

  Vitest.it(
    "rejects invalid values for the option owned by the extension",
    () => {
      const raw = VsCodeTest.createTestNotebookDocument(
        "file:///test/notebook_mo.py",
        {
          data: {
            cells: [],
            metadata: {
              marimo: {
                appOptions: {
                  managed: { autoDownload: [42] },
                  passthrough: {},
                },
              },
            },
          },
        },
      );

      const result = Effect.runSync(
        Effect.result(MarimoNotebookDocument.from(raw).parseMetadata()),
      );
      Vitest.expect(Result.isFailure(result)).toBe(true);
    },
  );
});
