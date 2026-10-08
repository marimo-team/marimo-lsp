import { Option } from "effect";
import type * as vscode from "vscode";

import { SETUP_CELL_NAME } from "../constants.ts";
import { MarimoNotebookCell } from "../schemas/MarimoNotebookDocument.ts";
import { matchCells } from "./matchCells.ts";

/**
 * Reconcile parsed notebook source with the open notebook it reloads. Matched
 * cells keep their stable ID, outputs, execution state, and inactive source
 * projections. Unmatched cells get fresh UUIDs. Parsed IDs are never reused
 * because marimo's parser regenerates the same IDs on every parse.
 */
export function reconcileNotebook(
  incoming: vscode.NotebookData,
  live: vscode.NotebookData,
): vscode.NotebookData {
  const matches = matchLiveCells(live.cells, incoming.cells);
  // New IDs must not reuse any live identity, including a cell removed by reload.
  const reservedIds = new Set(
    live.cells.flatMap((cell) => {
      const id = metadataOf(cell)?.marimoRuntime.stableId;
      return id == null ? [] : [id];
    }),
  );
  // Retain each live ID at most once, repairing previously corrupted notebooks.
  const retainedIds = new Set<string>();

  return {
    ...incoming,
    cells: incoming.cells.map((cell, index) => {
      const liveCell = matches.get(index);
      const liveMetadata =
        liveCell === undefined ? undefined : metadataOf(liveCell);
      const incomingMetadata = metadataOf(cell);
      let stableId = liveMetadata?.marimoRuntime.stableId;
      if (isSetupCell(cell)) {
        stableId = SETUP_CELL_NAME;
      } else if (
        stableId == null ||
        stableId === SETUP_CELL_NAME ||
        retainedIds.has(stableId)
      ) {
        do {
          stableId = crypto.randomUUID();
        } while (reservedIds.has(stableId));
      }
      reservedIds.add(stableId);
      retainedIds.add(stableId);

      const metadata =
        liveCell === undefined
          ? cell.metadata
          : MarimoNotebookCell.retainSourceProjections(
              cell.metadata,
              liveMetadata?.marimo.sourceProjections ?? {
                markdown: null,
                sql: null,
              },
            );
      return {
        ...cell,
        metadata: MarimoNotebookCell.materializeRuntimeMetadata(metadata, {
          stableId,
          state:
            liveMetadata?.marimoRuntime.state ??
            incomingMetadata?.marimoRuntime.state,
        }),
        outputs: liveCell?.outputs ?? cell.outputs,
      };
    }),
  };
}

/**
 * Setup pairs by role. Ordinary cells pair by displayed source, ignoring kind
 * and language since both sides are classified the same way.
 */
function matchLiveCells(
  live: ReadonlyArray<vscode.NotebookCellData>,
  incoming: ReadonlyArray<vscode.NotebookCellData>,
): Map<number, vscode.NotebookCellData> {
  const matches = new Map<number, vscode.NotebookCellData>();
  const liveSetup = live.find(isSetupCell);
  const setupIndex = incoming.findIndex(isSetupCell);
  if (liveSetup !== undefined && setupIndex !== -1) {
    matches.set(setupIndex, liveSetup);
  }

  const liveCells = live.filter((cell) => !isSetupCell(cell));
  const incomingCells = incoming
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => !isSetupCell(cell));

  const matched = matchCells(
    liveCells.map((cell) => cell.value),
    incomingCells.map(({ cell }) => cell.value),
  );
  matched.forEach((liveIndex, i) => {
    if (liveIndex !== undefined) {
      matches.set(incomingCells[i].index, liveCells[liveIndex]);
    }
  });
  return matches;
}

function metadataOf(cell: vscode.NotebookCellData) {
  return Option.getOrUndefined(
    MarimoNotebookCell.decodeMetadata(cell.metadata),
  );
}

function isSetupCell(cell: vscode.NotebookCellData): boolean {
  return metadataOf(cell)?.marimo.name === SETUP_CELL_NAME;
}
