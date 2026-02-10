import type * as vscode from "vscode";

import { describe, expect, it } from "@effect/vitest";

import { enrichNotebookFromCached } from "../enrichNotebookFromCached.ts";

// Helper to create a cell with minimal required fields
function cell(
  value: string,
  options?: {
    kind?: vscode.NotebookCellKind;
    languageId?: string;
    stableId?: string;
    outputs?: vscode.NotebookCellOutput[];
  },
): vscode.NotebookCellData {
  return {
    kind: options?.kind ?? 2, // Code cell
    languageId: options?.languageId ?? "python",
    value,
    metadata: options?.stableId ? { stableId: options.stableId } : undefined,
    outputs: options?.outputs,
  };
}

// Helper to create notebook data
function notebook(cells: vscode.NotebookCellData[]): vscode.NotebookData {
  return { cells };
}

// Helper to extract stableIds from notebook
function getStableIds(nb: vscode.NotebookData): (string | undefined)[] {
  return nb.cells.map((c) => c.metadata?.stableId);
}

// Helper to create a compact view for snapshots: "[stableId]: code"
function snapshotView(nb: vscode.NotebookData): string {
  return nb.cells
    .map((c) => `[${c.metadata?.stableId ?? "?"}]: ${c.value}`)
    .join("\n");
}

describe("enrichNotebookFromCached", () => {
  describe("identical notebooks", () => {
    it("preserves all stableIds when cells are identical", () => {
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

      const result = enrichNotebookFromCached(incoming, cached);

      expect(getStableIds(result)).toEqual(["id-1", "id-2", "id-3"]);
    });

    it("preserves outputs when cells are identical", () => {
      const mockOutput = {
        items: [{ data: "output data" }],
      } as unknown as vscode.NotebookCellOutput;
      const cached = notebook([
        cell("x = 1", { stableId: "id-1", outputs: [mockOutput] }),
      ]);
      const incoming = notebook([cell("x = 1", { stableId: "fresh-1" })]);

      const result = enrichNotebookFromCached(incoming, cached);

      expect(result.cells[0].outputs).toEqual([mockOutput]);
    });
  });

  describe("cell added at end", () => {
    it("preserves existing cell ids, new cell keeps fresh id", () => {
      const cached = notebook([
        cell("x = 1", { stableId: "id-1" }),
        cell("y = 2", { stableId: "id-2" }),
      ]);
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1" }),
        cell("y = 2", { stableId: "fresh-2" }),
        cell("z = 3", { stableId: "fresh-3" }),
      ]);

      const result = enrichNotebookFromCached(incoming, cached);

      expect(getStableIds(result)).toEqual(["id-1", "id-2", "fresh-3"]);
    });
  });

  describe("cell added at beginning", () => {
    it("preserves suffix cells, new cell keeps fresh id", () => {
      const cached = notebook([
        cell("y = 2", { stableId: "id-2" }),
        cell("z = 3", { stableId: "id-3" }),
      ]);
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1" }),
        cell("y = 2", { stableId: "fresh-2" }),
        cell("z = 3", { stableId: "fresh-3" }),
      ]);

      const result = enrichNotebookFromCached(incoming, cached);

      // First cell is new, last two match suffix
      expect(getStableIds(result)).toEqual(["fresh-1", "id-2", "id-3"]);
    });
  });

  describe("cell added in middle", () => {
    it("preserves prefix and suffix, new cell keeps fresh id", () => {
      const cached = notebook([
        cell("x = 1", { stableId: "id-1" }),
        cell("z = 3", { stableId: "id-3" }),
      ]);
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1" }),
        cell("y = 2", { stableId: "fresh-2" }),
        cell("z = 3", { stableId: "fresh-3" }),
      ]);

      const result = enrichNotebookFromCached(incoming, cached);

      // First cell matches prefix, last matches suffix, middle is new
      expect(getStableIds(result)).toEqual(["id-1", "fresh-2", "id-3"]);
    });
  });

  describe("cell deleted", () => {
    it("remaining cells preserve their ids", () => {
      const cached = notebook([
        cell("x = 1", { stableId: "id-1" }),
        cell("y = 2", { stableId: "id-2" }),
        cell("z = 3", { stableId: "id-3" }),
      ]);
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1" }),
        cell("z = 3", { stableId: "fresh-3" }),
      ]);

      const result = enrichNotebookFromCached(incoming, cached);

      expect(getStableIds(result)).toEqual(["id-1", "id-3"]);
    });
  });

  describe("cell content edited", () => {
    it("edited cell gets fresh id, unchanged cells preserve ids", () => {
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

      const result = enrichNotebookFromCached(incoming, cached);

      // First and last match, middle was edited so keeps fresh id
      expect(getStableIds(result)).toEqual(["id-1", "fresh-2", "id-3"]);
    });
  });

  describe("whitespace changes", () => {
    it("matches cells with leading/trailing whitespace trimmed", () => {
      const cached = notebook([cell("  x = 1  ", { stableId: "id-1" })]);
      const incoming = notebook([cell("x = 1", { stableId: "fresh-1" })]);

      const result = enrichNotebookFromCached(incoming, cached);

      expect(getStableIds(result)).toEqual(["id-1"]);
    });

    it("does NOT match cells with different internal content", () => {
      // Normalization only trims, doesn't change internal whitespace
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

      const result = enrichNotebookFromCached(incoming, cached);

      expect(getStableIds(result)).toEqual(["id-1", "fresh-2", "id-3"]);
    });
  });

  describe("cells reordered", () => {
    it("matches reordered cells by content", () => {
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

      const result = enrichNotebookFromCached(incoming, cached);

      expect(getStableIds(result)).toEqual(["id-c", "id-a", "id-b"]);
    });
  });

  describe("complex scenarios", () => {
    it("handles add, delete, and reorder together", () => {
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

      const result = enrichNotebookFromCached(incoming, cached);

      expect(getStableIds(result)).toEqual(["id-a", "id-d", "fresh-3", "id-c"]);
    });

    it("empty incoming notebook returns empty", () => {
      const cached = notebook([cell("x = 1", { stableId: "id-1" })]);
      const incoming = notebook([]);

      const result = enrichNotebookFromCached(incoming, cached);

      expect(result.cells).toEqual([]);
    });

    it("empty cached notebook keeps all fresh ids", () => {
      const cached = notebook([]);
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1" }),
        cell("y = 2", { stableId: "fresh-2" }),
      ]);

      const result = enrichNotebookFromCached(incoming, cached);

      expect(getStableIds(result)).toEqual(["fresh-1", "fresh-2"]);
    });
  });

  describe("language and kind matching", () => {
    it("exact match requires same language (prefix/suffix)", () => {
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

      const result = enrichNotebookFromCached(incoming, cached);

      // First cell has different language, breaks exact prefix match
      // But content matching in middle still finds it
      expect(getStableIds(result)).toEqual(["id-1", "id-2", "id-3"]);
    });

    it("content matching ignores language differences", () => {
      // When exact match fails, content-based matching only compares value
      const cached = notebook([
        cell("x = 1", { stableId: "id-1", languageId: "python" }),
      ]);
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1", languageId: "sql" }),
      ]);

      const result = enrichNotebookFromCached(incoming, cached);

      // Same content matches despite different language
      expect(getStableIds(result)).toEqual(["id-1"]);
    });

    it("content matching ignores kind differences", () => {
      const cached = notebook([
        cell("# Hello", { stableId: "id-1", kind: 1 }), // Markup
      ]);
      const incoming = notebook([
        cell("# Hello", { stableId: "fresh-1", kind: 2 }), // Code
      ]);

      const result = enrichNotebookFromCached(incoming, cached);

      // Same content matches despite different kind
      expect(getStableIds(result)).toEqual(["id-1"]);
    });
  });

  describe("snapshots", () => {
    // Base notebook used in snapshot tests
    const baseCached = notebook([
      cell("# Setup", { stableId: "cached-1" }),
      cell("x = 1", { stableId: "cached-2" }),
      cell("y = 2", { stableId: "cached-3" }),
      cell("z = 3", { stableId: "cached-4" }),
      cell("# End", { stableId: "cached-5" }),
    ]);

    it("add cell at beginning", () => {
      const incoming = notebook([
        cell("# New first", { stableId: "fresh-0" }),
        cell("# Setup", { stableId: "fresh-1" }),
        cell("x = 1", { stableId: "fresh-2" }),
        cell("y = 2", { stableId: "fresh-3" }),
        cell("z = 3", { stableId: "fresh-4" }),
        cell("# End", { stableId: "fresh-5" }),
      ]);

      const result = enrichNotebookFromCached(incoming, baseCached);
      expect(snapshotView(result)).toMatchInlineSnapshot(`
        "[fresh-0]: # New first
        [cached-1]: # Setup
        [cached-2]: x = 1
        [cached-3]: y = 2
        [cached-4]: z = 3
        [cached-5]: # End"
      `);
    });

    it("remove cell at beginning", () => {
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1" }),
        cell("y = 2", { stableId: "fresh-2" }),
        cell("z = 3", { stableId: "fresh-3" }),
        cell("# End", { stableId: "fresh-4" }),
      ]);

      const result = enrichNotebookFromCached(incoming, baseCached);
      expect(snapshotView(result)).toMatchInlineSnapshot(`
        "[cached-2]: x = 1
        [cached-3]: y = 2
        [cached-4]: z = 3
        [cached-5]: # End"
      `);
    });

    it("add cell in middle", () => {
      const incoming = notebook([
        cell("# Setup", { stableId: "fresh-1" }),
        cell("x = 1", { stableId: "fresh-2" }),
        cell("# New middle", { stableId: "fresh-new" }),
        cell("y = 2", { stableId: "fresh-3" }),
        cell("z = 3", { stableId: "fresh-4" }),
        cell("# End", { stableId: "fresh-5" }),
      ]);

      const result = enrichNotebookFromCached(incoming, baseCached);
      expect(snapshotView(result)).toMatchInlineSnapshot(`
        "[cached-1]: # Setup
        [cached-2]: x = 1
        [fresh-new]: # New middle
        [cached-3]: y = 2
        [cached-4]: z = 3
        [cached-5]: # End"
      `);
    });

    it("remove cell in middle", () => {
      const incoming = notebook([
        cell("# Setup", { stableId: "fresh-1" }),
        cell("x = 1", { stableId: "fresh-2" }),
        cell("z = 3", { stableId: "fresh-4" }),
        cell("# End", { stableId: "fresh-5" }),
      ]);

      const result = enrichNotebookFromCached(incoming, baseCached);
      expect(snapshotView(result)).toMatchInlineSnapshot(`
        "[cached-1]: # Setup
        [cached-2]: x = 1
        [cached-4]: z = 3
        [cached-5]: # End"
      `);
    });

    it("add cell at end", () => {
      const incoming = notebook([
        cell("# Setup", { stableId: "fresh-1" }),
        cell("x = 1", { stableId: "fresh-2" }),
        cell("y = 2", { stableId: "fresh-3" }),
        cell("z = 3", { stableId: "fresh-4" }),
        cell("# End", { stableId: "fresh-5" }),
        cell("# New last", { stableId: "fresh-6" }),
      ]);

      const result = enrichNotebookFromCached(incoming, baseCached);
      expect(snapshotView(result)).toMatchInlineSnapshot(`
        "[cached-1]: # Setup
        [cached-2]: x = 1
        [cached-3]: y = 2
        [cached-4]: z = 3
        [cached-5]: # End
        [fresh-6]: # New last"
      `);
    });

    it("remove cell at end", () => {
      const incoming = notebook([
        cell("# Setup", { stableId: "fresh-1" }),
        cell("x = 1", { stableId: "fresh-2" }),
        cell("y = 2", { stableId: "fresh-3" }),
        cell("z = 3", { stableId: "fresh-4" }),
      ]);

      const result = enrichNotebookFromCached(incoming, baseCached);
      expect(snapshotView(result)).toMatchInlineSnapshot(`
        "[cached-1]: # Setup
        [cached-2]: x = 1
        [cached-3]: y = 2
        [cached-4]: z = 3"
      `);
    });
  });
});
