import * as Vitest from "@effect/vitest";
import { Option } from "effect";
import type * as vscode from "vscode";

import { classifyCellCode } from "../../src/notebook/classifyCellCode.ts";
import { reconcileNotebook } from "../../src/notebook/reconcileNotebook.ts";
import { MarimoNotebookCell } from "../../src/schemas/MarimoNotebookDocument.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Helper to create a cell with minimal required fields
function cell(
  value: string,
  options?: {
    kind?: vscode.NotebookCellKind;
    languageId?: string;
    stableId?: string;
    name?: string;
    hideCode?: boolean;
    outputs?: vscode.NotebookCellOutput[];
  },
): vscode.NotebookCellData {
  return {
    kind: options?.kind ?? 2, // Code cell
    languageId: options?.languageId ?? "python",
    value,
    metadata:
      options?.stableId || options?.name
        ? MarimoNotebookCell.createMetadata({
            marimo: {
              name: options.name,
              options: { hide_code: options.hideCode },
            },
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

function cellFromSource(
  source: string,
  stableId: string,
): vscode.NotebookCellData {
  const classified = classifyCellCode(source, {
    Python: "mo-python",
    Markdown: "markdown",
    Sql: "sql",
  });
  return {
    kind: classified.kind,
    languageId: classified.languageId,
    value: classified.code,
    metadata: MarimoNotebookCell.createMetadata({
      marimo: { sourceProjections: classified.sourceProjections },
      marimoRuntime: { stableId },
    }),
  };
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
      const id = metadata?.marimoRuntime.stableId;
      return `[${id?.match(UUID) ? "<new>" : (id ?? "?")}]: ${c.value}`;
    })
    .join("\n");
}

Vitest.describe("reconcileNotebook", () => {
  Vitest.it.each([
    ["Python and markdown", "x = 1", 'mo.md("x = 1")'],
    ["markdown and SQL", 'mo.md("SELECT 1")', 'result = mo.sql("SELECT 1")'],
    [
      "SQL with different bindings",
      'first = mo.sql("SELECT 1")',
      'second = mo.sql("SELECT 1")',
    ],
  ])(
    "preserves IDs and outputs when %s cells with identical displayed text swap",
    (_, first, second) => {
      const live = notebook([
        cellFromSource(first, "first-id"),
        cellFromSource(second, "second-id"),
      ]);
      live.cells[0].outputs = [{ items: [], metadata: { label: "first" } }];
      live.cells[1].outputs = [{ items: [], metadata: { label: "second" } }];
      Vitest.expect(live.cells[0].value).toBe(live.cells[1].value);
      const incoming = notebook([
        cellFromSource(second, "Hbol"),
        cellFromSource(first, "MJUe"),
      ]);

      const result = reconcileNotebook(incoming, live);

      Vitest.expect(getStableIds(result)).toEqual(["second-id", "first-id"]);
      Vitest.expect(result.cells.map((cell) => cell.outputs)).toEqual([
        live.cells[1].outputs,
        live.cells[0].outputs,
      ]);
    },
  );

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

      const result = reconcileNotebook(incoming, cached);

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

        const result = reconcileNotebook(reloaded, cached);

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

      const result = reconcileNotebook(incoming, cached);

      Vitest.expect(result.cells[0].outputs).toEqual([mockOutput]);
    });
  });

  Vitest.describe("cell added at end", () => {
    Vitest.it("preserves existing cell ids, new cell gets a UUID", () => {
      const cached = notebook([
        cell("x = 1", { stableId: "id-1" }),
        cell("y = 2", { stableId: "id-2" }),
      ]);
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1" }),
        cell("y = 2", { stableId: "fresh-2" }),
        cell("z = 3", { stableId: "fresh-3" }),
      ]);

      const result = reconcileNotebook(incoming, cached);

      Vitest.expect(getStableIds(result)).toEqual([
        "id-1",
        "id-2",
        Vitest.expect.stringMatching(UUID),
      ]);
    });
  });

  Vitest.describe("cell added at beginning", () => {
    Vitest.it("preserves suffix cells, new cell gets a UUID", () => {
      const cached = notebook([
        cell("y = 2", { stableId: "id-2" }),
        cell("z = 3", { stableId: "id-3" }),
      ]);
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1" }),
        cell("y = 2", { stableId: "fresh-2" }),
        cell("z = 3", { stableId: "fresh-3" }),
      ]);

      const result = reconcileNotebook(incoming, cached);

      // First cell is new, last two match suffix
      Vitest.expect(getStableIds(result)).toEqual([
        Vitest.expect.stringMatching(UUID),
        "id-2",
        "id-3",
      ]);
    });
  });

  Vitest.describe("cell added in middle", () => {
    Vitest.it("preserves prefix and suffix, new cell gets a UUID", () => {
      const cached = notebook([
        cell("x = 1", { stableId: "id-1" }),
        cell("z = 3", { stableId: "id-3" }),
      ]);
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1" }),
        cell("y = 2", { stableId: "fresh-2" }),
        cell("z = 3", { stableId: "fresh-3" }),
      ]);

      const result = reconcileNotebook(incoming, cached);

      // First cell matches prefix, last matches suffix, middle is new
      Vitest.expect(getStableIds(result)).toEqual([
        "id-1",
        Vitest.expect.stringMatching(UUID),
        "id-3",
      ]);
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

      const result = reconcileNotebook(incoming, cached);

      Vitest.expect(getStableIds(result)).toEqual(["id-1", "id-3"]);
    });
  });

  Vitest.describe("cell content edited", () => {
    Vitest.it("edited cell preserves id via similarity", () => {
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

      const result = reconcileNotebook(incoming, cached);

      // First and last match exactly; the edited middle cell is the only
      // leftover on each side, so similarity pairs them
      Vitest.expect(getStableIds(result)).toEqual(["id-1", "id-2", "id-3"]);
    });
  });

  Vitest.describe("whitespace changes", () => {
    Vitest.it("matches cells with leading/trailing whitespace trimmed", () => {
      const cached = notebook([cell("  x = 1  ", { stableId: "id-1" })]);
      const incoming = notebook([cell("x = 1", { stableId: "fresh-1" })]);

      const result = reconcileNotebook(incoming, cached);

      Vitest.expect(getStableIds(result)).toEqual(["id-1"]);
    });

    Vitest.it(
      "matches cells with different internal content via similarity",
      () => {
        // Internal whitespace changes are not exact matches; they pair by
        // prefix/suffix similarity instead
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

        const result = reconcileNotebook(incoming, cached);

        // Similarity preserves identity for content-changed cells
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

      const result = reconcileNotebook(incoming, cached);

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

      const result = reconcileNotebook(incoming, cached);

      // b was deleted and "new" is genuinely new, but similarity matching
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

      const result = reconcileNotebook(incoming, cached);

      Vitest.expect(result.cells).toEqual([]);
    });

    Vitest.it("empty live notebook assigns new identities to all cells", () => {
      const cached = notebook([]);
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1" }),
        cell("y = 2", { stableId: "fresh-2" }),
      ]);

      const result = reconcileNotebook(incoming, cached);

      const ids = getStableIds(result);
      Vitest.expect(ids).toEqual([
        Vitest.expect.stringMatching(UUID),
        Vitest.expect.stringMatching(UUID),
      ]);
      Vitest.expect(new Set(ids).size).toBe(2);
    });
  });

  Vitest.describe("language and kind matching", () => {
    Vitest.it("pairs a language change after preserving exact sources", () => {
      const cached = notebook([
        cell("a = 1", { stableId: "id-1", languageId: "python" }),
        cell("x = 1", { stableId: "id-2", languageId: "python" }),
        cell("b = 2", { stableId: "id-3", languageId: "python" }),
      ]);
      const incoming = notebook([
        cell("a = 1", { stableId: "fresh-1", languageId: "sql" }), // different language
        cell("x = 1", { stableId: "fresh-2", languageId: "python" }),
        cell("b = 2", { stableId: "fresh-3", languageId: "python" }),
      ]);

      const result = reconcileNotebook(incoming, cached);

      // The other cells match exactly; the language change is the only
      // leftover pair and retains its identity through similarity matching.
      Vitest.expect(getStableIds(result)).toEqual(["id-1", "id-2", "id-3"]);
    });

    Vitest.it("pairs a lone cell across a language change", () => {
      const cached = notebook([
        cell("x = 1", { stableId: "id-1", languageId: "python" }),
      ]);
      const incoming = notebook([
        cell("x = 1", { stableId: "fresh-1", languageId: "sql" }),
      ]);

      const result = reconcileNotebook(incoming, cached);

      // The reconstructed sources differ, but leftovers are still paired.
      Vitest.expect(getStableIds(result)).toEqual(["id-1"]);
    });

    Vitest.it("pairs a lone cell across a kind change", () => {
      const cached = notebook([
        cell("# Hello", { stableId: "id-1", kind: 1 }), // Markup
      ]);
      const incoming = notebook([
        cell("# Hello", { stableId: "fresh-1", kind: 2 }), // Code
      ]);

      const result = reconcileNotebook(incoming, cached);

      // The reconstructed sources differ, but leftovers are still paired.
      Vitest.expect(getStableIds(result)).toEqual(["id-1"]);
    });
  });

  Vitest.describe("similarity matching (external edits)", () => {
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

        const result = reconcileNotebook(incoming, cached);

        // All cells preserve identity: unchanged cells exactly,
        // edited cells by similarity
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

      const result = reconcileNotebook(incoming, cached);

      // No exact matches, but similarity pairs all
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

        const result = reconcileNotebook(incoming, cached);

        // Similarity pairs the first two, the third is genuinely new
        Vitest.expect(getStableIds(result)).toEqual([
          "id-1",
          "id-2",
          Vitest.expect.stringMatching(UUID),
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

      const result = reconcileNotebook(incoming, cached);

      // Similarity pairs the first two, the third was deleted
      Vitest.expect(getStableIds(result)).toEqual(["id-1", "id-2"]);
    });
  });

  Vitest.describe("deterministic deserialized ids", () => {
    // marimo derives deserialized ids from a seeded generator, so a reload
    // assigns the same sequence (Hbol, MJUe, vblA, ...) that the live cells
    // received when the notebook was first opened.
    Vitest.it("gives an inserted cell a fresh id instead of a live one", () => {
      const cached = notebook([
        cell("x = 1", { stableId: "Hbol" }),
        cell("y = 2", { stableId: "MJUe" }),
        cell("z = 3", { stableId: "vblA" }),
      ]);
      const incoming = notebook([
        cell("x = 1", { stableId: "Hbol" }),
        cell("w = 0", { stableId: "MJUe" }),
        cell("y = 2", { stableId: "vblA" }),
        cell("z = 3", { stableId: "bkHC" }),
      ]);

      const result = reconcileNotebook(incoming, cached);

      const ids = getStableIds(result);
      Vitest.expect([ids[0], ids[2], ids[3]]).toEqual(["Hbol", "MJUe", "vblA"]);
      Vitest.expect(ids[1]).toMatch(UUID);
      Vitest.expect(new Set(ids).size).toBe(ids.length);
    });

    Vitest.it(
      "allocates a new identity even when the parsed id does not collide",
      () => {
        const cached = notebook([
          cell("x = 1", { stableId: "Hbol" }),
          cell("y = 2", { stableId: "MJUe" }),
        ]);
        const incoming = notebook([
          cell("x = 1", { stableId: "Hbol" }),
          cell("y = 2", { stableId: "MJUe" }),
          cell("z = 3", { stableId: "vblA" }),
        ]);

        const result = reconcileNotebook(incoming, cached);

        Vitest.expect(getStableIds(result)).toEqual([
          "Hbol",
          "MJUe",
          Vitest.expect.stringMatching(UUID),
        ]);

        const reloaded = reconcileNotebook(incoming, result);
        Vitest.expect(getStableIds(reloaded)).toEqual(getStableIds(result));
      },
    );

    Vitest.it(
      "repairs duplicate ids already present in the live notebook",
      () => {
        const cached = notebook([
          cell("x = 1", { stableId: "Hbol" }),
          cell("y = 2", { stableId: "Hbol" }),
        ]);
        const incoming = notebook([
          cell("x = 1", { stableId: "Hbol" }),
          cell("y = 2", { stableId: "MJUe" }),
        ]);

        const result = reconcileNotebook(incoming, cached);

        const ids = getStableIds(result);
        Vitest.expect(ids[0]).toBe("Hbol");
        Vitest.expect(new Set(ids).size).toBe(ids.length);
      },
    );
  });

  Vitest.describe("setup identity", () => {
    Vitest.it.each([false, true])(
      "preserves an ordinary cell named setup (setup block present: %s)",
      (hasSetup) => {
        const first = hasSetup
          ? cell("import math", { name: "setup", stableId: "setup" })
          : cell("x = 1", { stableId: "Hbol" });
        const ordinaryId = hasSetup ? "Hbol" : "MJUe";
        const live = notebook([
          first,
          cell("y = 2", {
            name: "setup",
            stableId: ordinaryId,
            outputs: [{ items: [], metadata: { label: "ordinary" } }],
          }),
        ]);
        const incoming = notebook([
          { ...first },
          cell("y = 2", { name: "setup", stableId: ordinaryId }),
        ]);

        const result = reconcileNotebook(incoming, live);

        Vitest.expect(getStableIds(result)).toEqual(getStableIds(live));
        Vitest.expect(result.cells[1].outputs).toEqual(live.cells[1].outputs);
      },
    );

    Vitest.it(
      "matches an edited setup cell separately from ordinary cells",
      () => {
        const live = notebook([
          cell("import old", { name: "setup", stableId: "setup" }),
          cell("x = 1", { stableId: "Hbol" }),
        ]);
        const incoming = notebook([
          cell("import new", { name: "setup", stableId: "setup" }),
          cell("w = 0", { stableId: "Hbol" }),
          cell("x = 1", { stableId: "MJUe" }),
        ]);

        Vitest.expect(getStableIds(reconcileNotebook(incoming, live))).toEqual([
          "setup",
          Vitest.expect.stringMatching(UUID),
          "Hbol",
        ]);
      },
    );

    Vitest.it(
      "reserves setup when inserting it alongside an ordinary edit",
      () => {
        const live = notebook([cell("x = 1", { stableId: "Hbol" })]);
        const incoming = notebook([
          cell("import math", { name: "setup", stableId: "setup" }),
          cell("x = 2", { stableId: "Hbol" }),
        ]);

        Vitest.expect(getStableIds(reconcileNotebook(incoming, live))).toEqual([
          "setup",
          "Hbol",
        ]);
      },
    );

    Vitest.it(
      "does not transfer a removed setup's identity or outputs to a new ordinary cell",
      () => {
        const live = notebook([
          cell("import math", {
            name: "setup",
            stableId: "setup",
            outputs: [{ items: [] }],
          }),
          cell("x = 1", { stableId: "Hbol" }),
        ]);
        const incoming = notebook([
          cell("w = 0", { stableId: "Hbol" }),
          cell("x = 1", { stableId: "MJUe" }),
        ]);

        const result = reconcileNotebook(incoming, live);

        Vitest.expect(getStableIds(result)).toEqual([
          Vitest.expect.stringMatching(UUID),
          "Hbol",
        ]);
        Vitest.expect(result.cells[0].outputs).toBeUndefined();
      },
    );
  });

  Vitest.it(
    "reserves later live IDs before allocating an inserted cell's UUID",
    () => {
      const liveId = "00000000-0000-4000-8000-000000000001";
      const newId = "00000000-0000-4000-8000-000000000002";
      using randomUUID = Vitest.vi
        .spyOn(crypto, "randomUUID")
        .mockReturnValueOnce(liveId)
        .mockReturnValueOnce(newId);
      const live = notebook([cell("x = 1", { stableId: liveId })]);
      const incoming = notebook([
        cell("w = 0", { stableId: "Hbol" }),
        cell("x = 1", { stableId: "MJUe" }),
      ]);

      Vitest.expect(getStableIds(reconcileNotebook(incoming, live))).toEqual([
        newId,
        liveId,
      ]);
      Vitest.expect(randomUUID).toHaveBeenCalledTimes(2);
    },
  );

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

      const result = reconcileNotebook(incoming, baseCached);
      Vitest.expect(snapshotView(result)).toMatchInlineSnapshot(`
        "[<new>]: # New first
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

      const result = reconcileNotebook(incoming, baseCached);
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

      const result = reconcileNotebook(incoming, baseCached);
      Vitest.expect(snapshotView(result)).toMatchInlineSnapshot(`
        "[cached-1]: # Setup
        [cached-2]: x = 1
        [<new>]: # New middle
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

      const result = reconcileNotebook(incoming, baseCached);
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

      const result = reconcileNotebook(incoming, baseCached);
      Vitest.expect(snapshotView(result)).toMatchInlineSnapshot(`
        "[cached-1]: # Setup
        [cached-2]: x = 1
        [cached-3]: y = 2
        [cached-4]: z = 3
        [cached-5]: # End
        [<new>]: # New last"
      `);
    });

    Vitest.it("remove cell at end", () => {
      const incoming = notebook([
        cell("# Setup", { stableId: "fresh-1" }),
        cell("x = 1", { stableId: "fresh-2" }),
        cell("y = 2", { stableId: "fresh-3" }),
        cell("z = 3", { stableId: "fresh-4" }),
      ]);

      const result = reconcileNotebook(incoming, baseCached);
      Vitest.expect(snapshotView(result)).toMatchInlineSnapshot(`
        "[cached-1]: # Setup
        [cached-2]: x = 1
        [cached-3]: y = 2
        [cached-4]: z = 3"
      `);
    });
  });
});
