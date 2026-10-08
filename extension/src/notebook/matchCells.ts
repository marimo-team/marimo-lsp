/**
 * Match incoming cells to previous cells by source so a reload keeps their IDs
 * and outputs. Ported from marimo's `cell_matching` so a reload in VS Code
 * pairs cells the way marimo's file watcher does.
 *
 *   pass 1  exact source, nearest previous cell wins for duplicates
 *   pass 2  leftovers paired by minimum total prefix/suffix edit distance,
 *           ties broken by how far a cell would move
 *
 * Leftovers are always paired. A wrong pair shows a stale output until the
 * next run. A missed pair gives the cell a new kernel ID and invalidates its
 * dependents.
 *
 * Returns the previous index for each incoming index, `undefined` if new.
 */
export function matchCells(
  previous: readonly string[],
  incoming: readonly string[],
): ReadonlyArray<number | undefined> {
  const result: Array<number | undefined> = Array.from(
    { length: incoming.length },
    () => undefined,
  );

  const previousBySource = new Map<string, number[]>();
  previous.forEach((source, index) => {
    const indices = previousBySource.get(source);
    if (indices) indices.push(index);
    else previousBySource.set(source, [index]);
  });

  const claimed = new Set<number>();
  incoming.forEach((source, index) => {
    const candidates = previousBySource.get(source);
    if (candidates === undefined || candidates.length === 0) return;
    const match = popNearest(candidates, index);
    result[index] = match;
    claimed.add(match);
  });

  const leftPrevious = previous
    .map((_, index) => index)
    .filter((index) => !claimed.has(index));
  const leftIncoming = incoming
    .map((_, index) => index)
    .filter((index) => result[index] === undefined);
  if (leftPrevious.length === 0 || leftIncoming.length === 0) return result;

  // Zero-cost padding squares the matrix without affecting real pairs.
  const n = Math.max(leftPrevious.length, leftIncoming.length);
  // Position only breaks ties. Trimming keeps a formatter pass a small edit.
  const tieScale = previous.length + incoming.length + 1;
  const cost = Array.from({ length: n }, (_, row) =>
    Array.from({ length: n }, (_, column) => {
      if (row >= leftPrevious.length || column >= leftIncoming.length) return 0;
      const p = leftPrevious[row];
      const q = leftIncoming[column];
      return (
        editDistance(previous[p].trim(), incoming[q].trim()) * tieScale +
        Math.abs(p - q)
      );
    }),
  );

  const assignment = assignMinimumCost(cost);
  leftPrevious.forEach((p, row) => {
    const column = assignment[row];
    if (column < leftIncoming.length) result[leftIncoming[column]] = p;
  });
  return result;
}

/** Remove and return the candidate index closest to `index`, preferring the lower index on ties. */
function popNearest(candidates: number[], index: number): number {
  let best = 0;
  for (let i = 1; i < candidates.length; i++) {
    if (Math.abs(candidates[i] - index) < Math.abs(candidates[best] - index)) {
      best = i;
    }
  }
  return candidates.splice(best, 1)[0];
}

/** Characters outside the common prefix and non-overlapping suffix. */
export function editDistance(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < limit && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  return a.length + b.length - 2 * (prefix + suffix);
}

/** Kuhn-Munkres minimum-cost assignment. Returns the column for each row. */
function assignMinimumCost(cost: ReadonlyArray<ReadonlyArray<number>>) {
  const n = cost.length;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const rowOfColumn = new Array<number>(n + 1).fill(0);
  const way = new Array<number>(n + 1).fill(0);

  for (let row = 1; row <= n; row++) {
    rowOfColumn[0] = row;
    let column = 0;
    const minv = new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[column] = true;
      const current = rowOfColumn[column];
      let delta = Number.POSITIVE_INFINITY;
      let next = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const reduced = cost[current - 1][j - 1] - u[current] - v[j];
        if (reduced < minv[j]) {
          minv[j] = reduced;
          way[j] = column;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          next = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[rowOfColumn[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      column = next;
    } while (rowOfColumn[column] !== 0);
    do {
      const previousColumn = way[column];
      rowOfColumn[column] = rowOfColumn[previousColumn];
      column = previousColumn;
    } while (column !== 0);
  }

  const columnOfRow = new Array<number>(n).fill(-1);
  for (let j = 1; j <= n; j++) {
    if (rowOfColumn[j] !== 0) columnOfRow[rowOfColumn[j] - 1] = j - 1;
  }
  return columnOfRow;
}
