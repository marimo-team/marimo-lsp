import * as Vitest from "@effect/vitest";
import { Option } from "effect";
import type * as vscode from "vscode";

import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import { enrichNotebookFromLive } from "../enrichNotebookFromLive.ts";

// Helper to create a cell with minimal required fields
function cell(
  value: string,
  options?: {
    kind?: vscode.NotebookCellKind;
    languageId?: string;
    stableId?: string;
    hideCode?: boolean;
    outputs?: vscode.NotebookCellOutput[];
  },
): vscode.NotebookCellData {
  return {
    kind: options?.kind ?? 2, // Code cell
    languageId: options?.languageId ?? "python",
    value,
    metadata: options?.stableId
      ? MarimoNotebookCell.createMetadata({
          ...(options.hideCode === undefined
            ? {}
            : { marimo: { options: { hide_code: options.hideCode } } }),
          marimoRuntime: { stableId: options.stableId },
        })
      : undefined,
    outputs: options?.outputs,
  };
}

// Helper to create notebook data
function notebook(cells: vscode.NotebookCellData[]): vscode.NotebookData {
  return { cells };
}

// Helper to extract stableIds from notebook
function getStableIds(nb: vscode.NotebookData): (string | undefined)[] {
  return nb.cells.map(
    (c) =>
      Option.getOrUndefined(MarimoNotebookCell.decodeMetadata(c.metadata))
        ?.marimoRuntime.stableId ?? undefined,
  );
}

function getHideCode(nb: vscode.NotebookData): (boolean | undefined)[] {
  return nb.cells.map(
    (c) =>
      Option.getOrUndefined(MarimoNotebookCell.decodeMetadata(c.metadata))
        ?.marimo.options.hide_code ?? undefined,
  );
}

// Helper to create a compact view for snapshots: "[stableId]: code"
function snapshotView(nb: vscode.NotebookData): string {
  return nb.cells
    .map((c) => {
      const metadata = Option.getOrUndefined(
        MarimoNotebookCell.decodeMetadata(c.metadata),
      );
      return `[${metadata?.marimoRuntime.stableId ?? "?"}]: ${c.value}`;
    })
    .join("\n");
}

Vitest.describe("enrichNotebookFromLive", () => {
  Vitest.describe("identical notebooks", () => {
    Vitest.it("preserves all stableIds when cells are identical", () => {
      const cached = notebook([
        cell("x = 1", { stableId: "id-1" }),
        cell("y = 2", { stableId: "id-2" }),
        cell("z = 3", { stableId: "id-3" }),
      ]);
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1" }),
        cell("y = 2", { stableId: "fresh-2" }),
        cell("z = 3", { stableId: "fresh-3" }),
      ]);

      const result = enrichNotebookFromLive(incoming, cached);

      Vitest.expect(getStableIds(result)).toEqual(["id-1", "id-2", "id-3"]);
    });

    Vitest.it.each([
      { live: false, incoming: true },
      { live: true, incoming: false },
    ])(
      "keeps live identity while accepting an external hide_code change from $live to $incoming",
      ({ live, incoming }) => {
        const cached = notebook([
          cell("x = 1", { stableId: "id-1", hideCode: live }),
        ]);
        const reloaded = notebook([
          cell("x = 1", { stableId: "fresh-1", hideCode: incoming }),
        ]);

        const result = enrichNotebookFromLive(reloaded, cached);

        Vitest.expect(getStableIds(result)).toEqual(["id-1"]);
        Vitest.expect(getHideCode(result)).toEqual([incoming]);
      },
    );

    Vitest.it("preserves outputs when cells are identical", () => {
      // SAFETY: test fixture — the enrich logic under test only reads `.items`,
      // so a minimal object is sufficient and avoids constructing a full
      // vscode.NotebookCellOutput (which requires NotebookCellOutputItems with
      // Uint8Array buffers).
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const mockOutput = {
        items: [{ data: "output data" }],
      } as unknown as vscode.NotebookCellOutput;
      const cached = notebook([
        cell("x = 1", { stableId: "id-1", outputs: [mockOutput] }),
      ]);
      const incoming = notebook([cell("x = 1", { stableId: "fresh-1" })]);

      const result = enrichNotebookFromLive(incoming, cached);

      Vitest.expect(result.cells[0].outputs).toEqual([mockOutput]);
    });
  });

  Vitest.describe("cell added at end", () => {
    Vitest.it("preserves existing cell ids, new cell keeps fresh id", () => {
      const cached = notebook([
        cell("x = 1", { stableId: "id-1" }),
        cell("y = 2", { stableId: "id-2" }),
      ]);
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1" }),
        cell("y = 2", { stableId: "fresh-2" }),
        cell("z = 3", { stableId: "fresh-3" }),
      ]);

      const result = enrichNotebookFromLive(incoming, cached);

      Vitest.expect(getStableIds(result)).toEqual(["id-1", "id-2", "fresh-3"]);
    });
  });

  Vitest.describe("cell added at beginning", () => {
    Vitest.it("preserves suffix cells, new cell keeps fresh id", () => {
      const cached = notebook([
        cell("y = 2", { stableId: "id-2" }),
        cell("z = 3", { stableId: "id-3" }),
      ]);
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1" }),
        cell("y = 2", { stableId: "fresh-2" }),
        cell("z = 3", { stableId: "fresh-3" }),
      ]);

      const result = enrichNotebookFromLive(incoming, cached);

      // First cell is new, last two match suffix
      Vitest.expect(getStableIds(result)).toEqual(["fresh-1", "id-2", "id-3"]);
    });
  });

  Vitest.describe("cell added in middle", () => {
    Vitest.it("preserves prefix and suffix, new cell keeps fresh id", () => {
      const cached = notebook([
        cell("x = 1", { stableId: "id-1" }),
        cell("z = 3", { stableId: "id-3" }),
      ]);
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1" }),
        cell("y = 2", { stableId: "fresh-2" }),
        cell("z = 3", { stableId: "fresh-3" }),
      ]);

      const result = enrichNotebookFromLive(incoming, cached);

      // First cell matches prefix, last matches suffix, middle is new
      Vitest.expect(getStableIds(result)).toEqual(["id-1", "fresh-2", "id-3"]);
    });
  });

  Vitest.describe("cell deleted", () => {
    Vitest.it("remaining cells preserve their ids", () => {
      const cached = notebook([
        cell("x = 1", { stableId: "id-1" }),
        cell("y = 2", { stableId: "id-2" }),
        cell("z = 3", { stableId: "id-3" }),
      ]);
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1" }),
        cell("z = 3", { stableId: "fresh-3" }),
      ]);

      const result = enrichNotebookFromLive(incoming, cached);

      Vitest.expect(getStableIds(result)).toEqual(["id-1", "id-3"]);
    });
  });

  Vitest.describe("cell content edited", () => {
    Vitest.it("edited cell preserves id via positional fallback", () => {
      const cached = notebook([
        cell("x = 1", { stableId: "id-1" }),
        cell("y = 2", { stableId: "id-2" }),
        cell("z = 3", { stableId: "id-3" }),
      ]);
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1" }),
        cell("y = 999", { stableId: "fresh-2" }), // edited
        cell("z = 3", { stableId: "fresh-3" }),
      ]);

      const result = enrichNotebookFromLive(incoming, cached);

      // First and last match via prefix/suffix, edited middle cell
      // preserves identity via positional fallback
      Vitest.expect(getStableIds(result)).toEqual(["id-1", "id-2", "id-3"]);
    });
  });

  Vitest.describe("whitespace changes", () => {
    Vitest.it("matches cells with leading/trailing whitespace trimmed", () => {
      const cached = notebook([cell("  x = 1  ", { stableId: "id-1" })]);
      const incoming = notebook([cell("x = 1", { stableId: "fresh-1" })]);

      const result = enrichNotebookFromLive(incoming, cached);

      Vitest.expect(getStableIds(result)).toEqual(["id-1"]);
    });

    Vitest.it(
      "matches cells with different internal content via positional fallback",
      () => {
        // Normalization only trims; internal whitespace changes are caught
        // by positional fallback (Pass 3) instead
        const cached = notebook([
          cell("x = 1", { stableId: "id-1" }),
          cell("y=2", { stableId: "id-2" }),
          cell("z = 3", { stableId: "id-3" }),
        ]);
        const incoming = notebook([
          cell("x = 1", { stableId: "fresh-1" }),
          cell("y = 2", { stableId: "fresh-2" }), // different internal spacing
          cell("z = 3", { stableId: "fresh-3" }),
        ]);

        const result = enrichNotebookFromLive(incoming, cached);

        // Positional fallback preserves identity for content-changed cells
        Vitest.expect(getStableIds(result)).toEqual(["id-1", "id-2", "id-3"]);
      },
    );
  });

  Vitest.describe("cells reordered", () => {
    Vitest.it("matches reordered cells by content", () => {
      const cached = notebook([
        cell("a = 1", { stableId: "id-a" }),
        cell("b = 2", { stableId: "id-b" }),
        cell("c = 3", { stableId: "id-c" }),
      ]);
      const incoming = notebook([
        cell("c = 3", { stableId: "fresh-1" }),
        cell("a = 1", { stableId: "fresh-2" }),
        cell("b = 2", { stableId: "fresh-3" }),
      ]);

      const result = enrichNotebookFromLive(incoming, cached);

      Vitest.expect(getStableIds(result)).toEqual(["id-c", "id-a", "id-b"]);
    });
  });

  Vitest.describe("complex scenarios", () => {
    Vitest.it("handles add, delete, and reorder together", () => {
      const cached = notebook([
        cell("a = 1", { stableId: "id-a" }),
        cell("b = 2", { stableId: "id-b" }),
        cell("c = 3", { stableId: "id-c" }),
        cell("d = 4", { stableId: "id-d" }),
      ]);
      const incoming = notebook([
        cell("a = 1", { stableId: "fresh-1" }), // same position
        cell("d = 4", { stableId: "fresh-2" }), // moved from end
        cell("new = 0", { stableId: "fresh-3" }), // brand new
        cell("c = 3", { stableId: "fresh-4" }), // moved
        // b was deleted
      ]);

      const result = enrichNotebookFromLive(incoming, cached);

      // b was deleted and "new" is genuinely new, but positional fallback
      // pairs the one remaining unmatched cached cell (b) with the one
      // remaining unmatched incoming cell (new), preserving b's identity.
      Vitest.expect(getStableIds(result)).toEqual([
        "id-a",
        "id-d",
        "id-b",
        "id-c",
      ]);
    });

    Vitest.it("empty incoming notebook returns empty", () => {
      const cached = notebook([cell("x = 1", { stableId: "id-1" })]);
      const incoming = notebook([]);

      const result = enrichNotebookFromLive(incoming, cached);

      Vitest.expect(result.cells).toEqual([]);
    });

    Vitest.it("empty cached notebook keeps all fresh ids", () => {
      const cached = notebook([]);
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1" }),
        cell("y = 2", { stableId: "fresh-2" }),
      ]);

      const result = enrichNotebookFromLive(incoming, cached);

      Vitest.expect(getStableIds(result)).toEqual(["fresh-1", "fresh-2"]);
    });
  });

  Vitest.describe("language and kind matching", () => {
    Vitest.it("exact match requires same language (prefix/suffix)", () => {
      // Cells in same position with different language won't match in prefix/suffix
      const cached = notebook([
        cell("a = 1", { stableId: "id-1", languageId: "python" }),
        cell("x = 1", { stableId: "id-2", languageId: "python" }),
        cell("b = 2", { stableId: "id-3", languageId: "python" }),
      ]);
      const incoming = notebook([
        cell("a = 1", { stableId: "fresh-1", languageId: "sql" }), // different language breaks prefix
        cell("x = 1", { stableId: "fresh-2", languageId: "python" }),
        cell("b = 2", { stableId: "fresh-3", languageId: "python" }),
      ]);

      const result = enrichNotebookFromLive(incoming, cached);

      // First cell has different language, breaks exact prefix match
      // But content matching in middle still finds it
      Vitest.expect(getStableIds(result)).toEqual(["id-1", "id-2", "id-3"]);
    });

    Vitest.it("content matching ignores language differences", () => {
      // When exact match fails, content-based matching only compares value
      const cached = notebook([
        cell("x = 1", { stableId: "id-1", languageId: "python" }),
      ]);
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1", languageId: "sql" }),
      ]);

      const result = enrichNotebookFromLive(incoming, cached);

      // Same content matches despite different language
      Vitest.expect(getStableIds(result)).toEqual(["id-1"]);
    });

    Vitest.it("content matching ignores kind differences", () => {
      const cached = notebook([
        cell("# Hello", { stableId: "id-1", kind: 1 }), // Markup
      ]);
      const incoming = notebook([
        cell("# Hello", { stableId: "fresh-1", kind: 2 }), // Code
      ]);

      const result = enrichNotebookFromLive(incoming, cached);

      // Same content matches despite different kind
      Vitest.expect(getStableIds(result)).toEqual(["id-1"]);
    });
  });

  Vitest.describe("positional fallback (external edits)", () => {
    Vitest.it(
      "preserves identity when AI edits multiple cells in place",
      () => {
        const cached = notebook([
          cell("import pandas as pd", { stableId: "id-1" }),
          cell("df = pd.read_csv('data.csv')", { stableId: "id-2" }),
          cell("df.head()", { stableId: "id-3" }),
          cell("df.describe()", { stableId: "id-4" }),
        ]);
        const incoming = notebook([
          cell("import pandas as pd", { stableId: "fresh-1" }),
          cell("df = pd.read_csv('data.csv', encoding='utf-8')", {
            stableId: "fresh-2",
          }), // edited
          cell("df.head(10)", { stableId: "fresh-3" }), // edited
          cell("df.describe()", { stableId: "fresh-4" }),
        ]);

        const result = enrichNotebookFromLive(incoming, cached);

        // All cells preserve identity — unchanged via prefix/suffix,
        // edited via positional fallback
        Vitest.expect(getStableIds(result)).toEqual([
          "id-1",
          "id-2",
          "id-3",
          "id-4",
        ]);
      },
    );

    Vitest.it("preserves identity when all cells are edited", () => {
      const cached = notebook([
        cell("x = 1", { stableId: "id-1" }),
        cell("y = 2", { stableId: "id-2" }),
        cell("z = 3", { stableId: "id-3" }),
      ]);
      const incoming = notebook([
        cell("x = 10", { stableId: "fresh-1" }),
        cell("y = 20", { stableId: "fresh-2" }),
        cell("z = 30", { stableId: "fresh-3" }),
      ]);

      const result = enrichNotebookFromLive(incoming, cached);

      // No prefix or suffix matches, but positional fallback pairs all
      Vitest.expect(getStableIds(result)).toEqual(["id-1", "id-2", "id-3"]);
    });

    Vitest.it(
      "handles edit + add: existing cells keep identity, new cell gets fresh id",
      () => {
        const cached = notebook([
          cell("x = 1", { stableId: "id-1" }),
          cell("y = 2", { stableId: "id-2" }),
        ]);
        const incoming = notebook([
          cell("x = 10", { stableId: "fresh-1" }), // edited
          cell("y = 20", { stableId: "fresh-2" }), // edited
          cell("z = 30", { stableId: "fresh-3" }), // new
        ]);

        const result = enrichNotebookFromLive(incoming, cached);

        // Positional fallback pairs first two, third is genuinely new
        Vitest.expect(getStableIds(result)).toEqual([
          "id-1",
          "id-2",
          "fresh-3",
        ]);
      },
    );

    Vitest.it("handles edit + delete: remaining cells keep identity", () => {
      const cached = notebook([
        cell("x = 1", { stableId: "id-1" }),
        cell("y = 2", { stableId: "id-2" }),
        cell("z = 3", { stableId: "id-3" }),
      ]);
      const incoming = notebook([
        cell("x = 10", { stableId: "fresh-1" }), // edited
        cell("y = 20", { stableId: "fresh-2" }), // edited
        // z was deleted
      ]);

      const result = enrichNotebookFromLive(incoming, cached);

      // Positional fallback pairs first two, third was deleted
      Vitest.expect(getStableIds(result)).toEqual(["id-1", "id-2"]);
    });
  });

  Vitest.describe("snapshots", () => {
    // Base notebook used in snapshot tests
    const baseCached = notebook([
      cell("# Setup", { stableId: "cached-1" }),
      cell("x = 1", { stableId: "cached-2" }),
      cell("y = 2", { stableId: "cached-3" }),
      cell("z = 3", { stableId: "cached-4" }),
      cell("# End", { stableId: "cached-5" }),
    ]);

    Vitest.it("add cell at beginning", () => {
      const incoming = notebook([
        cell("# New first", { stableId: "fresh-0" }),
        cell("# Setup", { stableId: "fresh-1" }),
        cell("x = 1", { stableId: "fresh-2" }),
        cell("y = 2", { stableId: "fresh-3" }),
        cell("z = 3", { stableId: "fresh-4" }),
        cell("# End", { stableId: "fresh-5" }),
      ]);

      const result = enrichNotebookFromLive(incoming, baseCached);
      Vitest.expect(snapshotView(result)).toMatchInlineSnapshot(`
        "[fresh-0]: # New first
        [cached-1]: # Setup
        [cached-2]: x = 1
        [cached-3]: y = 2
        [cached-4]: z = 3
        [cached-5]: # End"
      `);
    });

    Vitest.it("remove cell at beginning", () => {
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1" }),
        cell("y = 2", { stableId: "fresh-2" }),
        cell("z = 3", { stableId: "fresh-3" }),
        cell("# End", { stableId: "fresh-4" }),
      ]);

      const result = enrichNotebookFromLive(incoming, baseCached);
      Vitest.expect(snapshotView(result)).toMatchInlineSnapshot(`
        "[cached-2]: x = 1
        [cached-3]: y = 2
        [cached-4]: z = 3
        [cached-5]: # End"
      `);
    });

    Vitest.it("add cell in middle", () => {
      const incoming = notebook([
        cell("# Setup", { stableId: "fresh-1" }),
        cell("x = 1", { stableId: "fresh-2" }),
        cell("# New middle", { stableId: "fresh-new" }),
        cell("y = 2", { stableId: "fresh-3" }),
        cell("z = 3", { stableId: "fresh-4" }),
        cell("# End", { stableId: "fresh-5" }),
      ]);

      const result = enrichNotebookFromLive(incoming, baseCached);
      Vitest.expect(snapshotView(result)).toMatchInlineSnapshot(`
        "[cached-1]: # Setup
        [cached-2]: x = 1
        [fresh-new]: # New middle
        [cached-3]: y = 2
        [cached-4]: z = 3
        [cached-5]: # End"
      `);
    });

    Vitest.it("remove cell in middle", () => {
      const incoming = notebook([
        cell("# Setup", { stableId: "fresh-1" }),
        cell("x = 1", { stableId: "fresh-2" }),
        cell("z = 3", { stableId: "fresh-4" }),
        cell("# End", { stableId: "fresh-5" }),
      ]);

      const result = enrichNotebookFromLive(incoming, baseCached);
      Vitest.expect(snapshotView(result)).toMatchInlineSnapshot(`
        "[cached-1]: # Setup
        [cached-2]: x = 1
        [cached-4]: z = 3
        [cached-5]: # End"
      `);
    });

    Vitest.it("add cell at end", () => {
      const incoming = notebook([
        cell("# Setup", { stableId: "fresh-1" }),
        cell("x = 1", { stableId: "fresh-2" }),
        cell("y = 2", { stableId: "fresh-3" }),
        cell("z = 3", { stableId: "fresh-4" }),
        cell("# End", { stableId: "fresh-5" }),
        cell("# New last", { stableId: "fresh-6" }),
      ]);

      const result = enrichNotebookFromLive(incoming, baseCached);
      Vitest.expect(snapshotView(result)).toMatchInlineSnapshot(`
        "[cached-1]: # Setup
        [cached-2]: x = 1
        [cached-3]: y = 2
        [cached-4]: z = 3
        [cached-5]: # End
        [fresh-6]: # New last"
      `);
    });

    Vitest.it("remove cell at end", () => {
      const incoming = notebook([
        cell("# Setup", { stableId: "fresh-1" }),
        cell("x = 1", { stableId: "fresh-2" }),
        cell("y = 2", { stableId: "fresh-3" }),
        cell("z = 3", { stableId: "fresh-4" }),
      ]);

      const result = enrichNotebookFromLive(incoming, baseCached);
      Vitest.expect(snapshotView(result)).toMatchInlineSnapshot(`
        "[cached-1]: # Setup
        [cached-2]: x = 1
        [cached-3]: y = 2
        [cached-4]: z = 3"
      `);
    });
  });
});
