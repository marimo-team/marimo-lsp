import * as Vitest from "@effect/vitest";

import { editDistance, matchCells } from "../../src/notebook/matchCells.ts";

/** Match and report the previous cell's id for each incoming cell (`undefined` = new). */
function match(
  previous: ReadonlyArray<readonly [id: string, source: string]>,
  incoming: readonly string[],
): ReadonlyArray<string | undefined> {
  const result = matchCells(
    previous.map(([, source]) => source),
    incoming,
  );
  return result.map((index) =>
    index === undefined ? undefined : previous[index][0],
  );
}

// Fixtures from marimo's `TestCellMatching`. Where marimo's answer depends only
// on tie-breaking, the expectation here is ours.
Vitest.describe("matchCells", () => {
  Vitest.it("pairs exact sources", () => {
    const result = match(
      [
        ["a", "abc"],
        ["b", "def"],
        ["c", "ghi"],
      ],
      ["abc", "def", "ghi"],
    );
    Vitest.expect(result).toEqual(["a", "b", "c"]);
  });

  Vitest.it("follows reordered sources", () => {
    const result = match(
      [
        ["a", "abc"],
        ["b", "def"],
        ["c", "ghi"],
      ],
      ["def", "ghi", "abc"],
    );
    Vitest.expect(result).toEqual(["b", "c", "a"]);
  });

  Vitest.it("pairs edited sources by similarity", () => {
    const result = match(
      [
        ["a", "abc"],
        ["b", "def"],
        ["c", "ghi"],
      ],
      ["ghij", "abcd", "defg"],
    );
    Vitest.expect(result).toEqual(["c", "a", "b"]);
  });

  Vitest.it("pairs similar sources with duplicates on both sides", () => {
    const result = match(
      [
        ["a", "abc"],
        ["b", "def"],
        ["c", "ghi"],
        ["x", "ghi"],
      ],
      ["ghij", "abcd", "defg", "ghij"],
    );
    Vitest.expect(result).toEqual(["c", "a", "b", "x"]);
  });

  Vitest.it("gives a duplicated edit to the nearest previous cell", () => {
    // marimo gives `ghi` to the first `ghij`; we give it to the closer one.
    const result = match(
      [
        ["a", "abc"],
        ["b", "def"],
        ["c", "ghi"],
      ],
      ["ghij", "abcd", "defg", "ghij"],
    );
    Vitest.expect(result).toEqual([undefined, "a", "b", "c"]);
  });

  Vitest.it("drops a surplus previous duplicate", () => {
    const result = match(
      [
        ["a", "abc"],
        ["b", "def"],
        ["c", "ghi"],
        ["x", "ghi"],
      ],
      ["ghij", "abcd", "defg"],
    );
    Vitest.expect(result).toEqual(["c", "a", "b"]);
  });

  Vitest.it("pairs an unrelated leftover rather than dropping it", () => {
    const result = match(
      [
        ["a", "abc"],
        ["b", "def"],
        ["c", "ghi"],
        ["x", "123"],
      ],
      ["ghij", "abcd", "defg", "abc"],
    );
    Vitest.expect(result).toEqual(["c", "x", "b", "a"]);
  });

  Vitest.it("prefers local pairings among equally similar duplicates", () => {
    const result = match(
      [
        ["a", "abc"],
        ["b", "def"],
        ["c", "ghi"],
        ["x", "def"],
        ["y", "abc"],
        ["z", "123"],
      ],
      ["ghij", "abcd", "defg", "defg", "ghij", "abc"],
    );
    Vitest.expect(result).toEqual(["c", "a", "b", "x", "z", "y"]);
  });

  Vitest.it("handles fewer incoming cells", () => {
    const result = match(
      [
        ["a", "abc"],
        ["b", "def"],
        ["c", "ghi"],
      ],
      ["abc", "ghi"],
    );
    Vitest.expect(result).toEqual(["a", "c"]);
  });

  Vitest.it("handles more incoming cells", () => {
    const result = match(
      [
        ["a", "abc"],
        ["b", "def"],
      ],
      ["def", "ghi", "abc"],
    );
    Vitest.expect(result).toEqual(["b", undefined, "a"]);
  });

  Vitest.it("pairs completely different sources by position", () => {
    const result = match(
      [
        ["a", "abc"],
        ["b", "def"],
      ],
      ["xyz", "123"],
    );
    Vitest.expect(result).toEqual(["a", "b"]);
  });

  Vitest.it("handles empty inputs", () => {
    Vitest.expect(match([], [])).toEqual([]);
    Vitest.expect(match([["a", "x"]], [])).toEqual([]);
    Vitest.expect(match([], ["x", "y"])).toEqual([undefined, undefined]);
    Vitest.expect(match([["a", ""]], [""])).toEqual(["a"]);
  });

  Vitest.it("uses the nearest of several identical previous cells", () => {
    const result = match(
      [
        ["a", "same"],
        ["b", "same"],
        ["c", "diff"],
      ],
      ["same", "diff"],
    );
    Vitest.expect(result).toEqual(["a", "c"]);
  });

  Vitest.it("leaves an extra identical incoming cell unmatched", () => {
    const result = match(
      [
        ["a", "code1"],
        ["b", "code2"],
      ],
      ["code1", "code1", "code2"],
    );
    Vitest.expect(result).toEqual(["a", undefined, "b"]);
  });

  Vitest.it("distinguishes long sources by their differing tail", () => {
    const prefix = "x".repeat(1000);
    const result = match(
      [
        ["a", `${prefix}1`],
        ["b", `${prefix}2`],
      ],
      [`${prefix}2`, `${prefix}1`],
    );
    Vitest.expect(result).toEqual(["b", "a"]);
  });

  Vitest.it("compares unicode and whitespace exactly", () => {
    Vitest.expect(
      match(
        [
          ["a", "🔥"],
          ["b", "∑∫"],
          ["c", "\n\t\r"],
        ],
        ["∑∫", "🔥", "\n\t\r"],
      ),
    ).toEqual(["b", "a", "c"]);
    Vitest.expect(
      match(
        [
          ["a", "ABC"],
          ["b", "def"],
        ],
        ["abc", "DEF"],
      ),
    ).toEqual(["a", "b"]);
    Vitest.expect(
      match(
        [
          ["a", "x  y"],
          ["b", "a\nb"],
        ],
        ["x y", "a b"],
      ),
    ).toEqual(["a", "b"]);
  });

  Vitest.it("keeps nested substrings and lengths apart", () => {
    Vitest.expect(
      match(
        [
          ["a", "x"],
          ["b", "xy"],
          ["c", "xyz"],
        ],
        ["xyz", "xy", "x"],
      ),
    ).toEqual(["c", "b", "a"]);
    Vitest.expect(
      match(
        [
          ["a", "x"],
          ["b", "x".repeat(10000)],
        ],
        ["x".repeat(10000), "x"],
      ),
    ).toEqual(["b", "a"]);
    Vitest.expect(
      match(
        [
          ["a", ""],
          ["b", "x"],
        ],
        ["x", ""],
      ),
    ).toEqual(["b", "a"]);
  });

  Vitest.it("pairs identical cells positionally", () => {
    const result = match(
      [
        ["a", "same"],
        ["b", "same"],
        ["c", "same"],
      ],
      ["same", "same", "same"],
    );
    Vitest.expect(result).toEqual(["a", "b", "c"]);
  });

  Vitest.it("keeps an edited cell when a dependency is deleted", () => {
    const result = match(
      [
        ["a", "y = x + 1"],
        ["b", "x = 1"],
      ],
      ["y = 2 + 1"],
    );
    Vitest.expect(result).toEqual(["a"]);
  });

  Vitest.it("keeps an edited cell beside an insertion", () => {
    const result = match(
      [
        ["a", "x = 1"],
        ["b", "y = 2"],
      ],
      ["x = 10", "z = 5", "y = 20"],
    );
    Vitest.expect(result).toEqual(["a", undefined, "b"]);
  });

  Vitest.it("never matches one previous cell twice", () => {
    // Deterministic pseudo-random notebooks over a tiny alphabet, so exact
    // duplicates, edits, insertions, and deletions all occur together.
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const alphabet = ["a", "ab", "abc", "b", ""];
    for (let round = 0; round < 300; round++) {
      const previous = Array.from(
        { length: next() % 7 },
        () => alphabet[next() % alphabet.length],
      );
      const incoming = Array.from(
        { length: next() % 7 },
        () => alphabet[next() % alphabet.length],
      );
      const result = matchCells(previous, incoming);
      const matched = result.filter((index) => index !== undefined);
      Vitest.expect(result).toHaveLength(incoming.length);
      Vitest.expect(new Set(matched).size).toBe(matched.length);
      Vitest.expect(matched).toHaveLength(
        Math.min(previous.length, incoming.length),
      );
      for (const index of matched) {
        Vitest.expect(index).toBeGreaterThanOrEqual(0);
        Vitest.expect(index).toBeLessThan(previous.length);
      }
    }
  });
});

Vitest.describe("editDistance", () => {
  Vitest.it("is zero for identical strings", () => {
    Vitest.expect(editDistance("", "")).toBe(0);
    Vitest.expect(editDistance("abc", "abc")).toBe(0);
  });

  Vitest.it("counts characters outside the common prefix and suffix", () => {
    Vitest.expect(editDistance("x = 1", "x = 10")).toBe(1);
    Vitest.expect(editDistance("abc", "xyz")).toBe(6);
    Vitest.expect(editDistance("  x = 1  ", "x = 1")).toBe(14);
  });

  Vitest.it("does not let the prefix and suffix overlap", () => {
    Vitest.expect(editDistance("ab", "aab")).toBe(1);
    Vitest.expect(editDistance("x", "xy")).toBe(1);
  });
});
