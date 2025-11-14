import * as vscode from "vscode";
import { getNotebookCellId, type NotebookCellId } from "../../utils/notebook";
import { getTopologicalCellIds, type Variables } from "./topologicalSort";
import type { VariablesOp } from "../../types";
import { Option } from "effect";

/**
 * Tracks the dependency order of cells in notebooks using topological sorting.
 *
 * This is crucial for LSP integration - cells need to be presented to the
 * language server in dependency order (dataflow order), not document order.
 *
 * For example, if cell B is defined before cell A in the document, but
 * A declares a variable that B uses, the LSP should see: A, then B.
 */
export class TopologicalOrderTracker {
  private variablesOps: Map<string, VariablesOp> = new Map();

  /**
   * Initialize for a notebook.
   * Stores empty variables initially.
   */
  public initializeNotebook(notebook: vscode.NotebookDocument): void {
    const notebookKey = notebook.uri.toString();
    this.variablesOps.set(notebookKey, { op: "variables", variables: [] });
  }

  /**
   * Update variable information for a notebook.
   * This should be called when the "variables" operation is received from marimo.
   */
  public updateVariables(
    notebook: vscode.NotebookDocument,
    variablesOp: VariablesOp
  ): void {
    const notebookKey = notebook.uri.toString();
    this.variablesOps.set(notebookKey, variablesOp);
  }

  /**
   * Update variable information from an Option<VariablesOp>.
   * This is a convenience method for working with Effect.ts Option types.
   */
  public updateVariablesFromOption(
    notebook: vscode.NotebookDocument,
    variablesOption: Option.Option<VariablesOp>
  ): void {
    if (Option.isSome(variablesOption)) {
      this.updateVariables(notebook, variablesOption.value);
    }
  }

  /**
   * Get cells in dependency order using topological sorting.
   * Returns cells sorted by variable dependencies.
   */
  public getCellsInDependencyOrder(
    notebook: vscode.NotebookDocument
  ): vscode.NotebookCell[] {
    const notebookKey = notebook.uri.toString();
    const variablesOp = this.variablesOps.get(notebookKey);

    // Get all cell IDs
    const cells = notebook.getCells();
    const cellIds = cells.map((cell) => getNotebookCellId(cell));


    if (!variablesOp || variablesOp.variables.length === 0) {
      // No variable information yet, return document order
      return cells;
    }


    // Convert VariablesOp format (declared_by/used_by) to Variables format (declaredBy/usedBy)
    const variables: Variables = {};
    for (const varDecl of variablesOp.variables) {
      variables[varDecl.name] = {
        declaredBy: varDecl.declared_by as NotebookCellId[],
        usedBy: varDecl.used_by as NotebookCellId[],
      };
    }


    // Get topologically sorted cell IDs
    const sortedCellIds = getTopologicalCellIds(cellIds, variables);

    // Map cell IDs back to cells
    const cellMap = new Map<string, vscode.NotebookCell>();
    for (const cell of cells) {
      cellMap.set(getNotebookCellId(cell), cell);
    }

    const orderedCells: vscode.NotebookCell[] = [];
    for (const cellId of sortedCellIds) {
      const cell = cellMap.get(cellId);
      if (cell) {
        orderedCells.push(cell);
      }
    }

    // Add any cells that aren't in the sorted order (shouldn't happen, but defensive)
    for (const cell of cells) {
      if (!orderedCells.includes(cell)) {
        orderedCells.push(cell);
      }
    }


    return orderedCells;
  }

  /**
   * Clear data for a notebook (e.g., when closed).
   */
  public clearNotebook(notebook: vscode.NotebookDocument): void {
    const notebookKey = notebook.uri.toString();
    this.variablesOps.delete(notebookKey);
  }

  /**
   * Handle cell structural changes (additions, deletions, moves).
   * No-op for now - we rely on variable updates from marimo.
   */
  public handleCellsChanged(
    notebook: vscode.NotebookDocument,
    changes: readonly vscode.NotebookDocumentCellChange[]
  ): void {
    // Variables will be updated by marimo when cells change
    // We don't need to do anything here
  }
}
