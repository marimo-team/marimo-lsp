import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { TopologicalOrderTracker } from "./TopologicalOrderTracker";
import { getCellExecutableCode } from "../../utils/getCellExecutableCode";
import { getNotebookCellId } from "../../utils/notebook";
import { lspProxyLogger } from "./LspProxyLogger";

/**
 * Position mapping between virtual document and notebook cells.
 */
export interface CellPosition {
  cellId: string;
  cellIndex: number;
  cell: vscode.NotebookCell;
  /** Start line in virtual document (0-based) */
  virtualStartLine: number;
  /** End line in virtual document (exclusive) */
  virtualEndLine: number;
}

/**
 * Provides temporary file-based "virtual" documents for notebooks.
 *
 * This creates a temporary .py file that concatenates all cells in
 * dependency order. This file is what we show to Pyright,
 * ensuring it sees cells in the correct dependency order.
 *
 * We use real files instead of virtual documents because Pyright only
 * analyzes documents with file:// URIs, not custom URI schemes.
 */
export class VirtualDocumentProvider {
  private cellMappings: Map<string, CellPosition[]> = new Map();
  private tempFiles: Map<string, string> = new Map(); // notebook URI -> temp file path
  private tempDir: string;
  private topologicalOrderTracker: TopologicalOrderTracker;

  constructor(topologicalOrderTracker: TopologicalOrderTracker) {
    this.topologicalOrderTracker = topologicalOrderTracker;

    // Create a temporary directory for virtual documents
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "marimo-vdoc-"));
    lspProxyLogger.log("VirtualDocumentProvider", `Created temp directory: ${this.tempDir}`);
  }

  /**
   * Get the virtual document URI for a notebook (temp file).
   */
  public getVirtualUriForNotebook(notebook: vscode.NotebookDocument): vscode.Uri {
    const notebookKey = notebook.uri.toString();
    let tempFilePath = this.tempFiles.get(notebookKey);

    if (!tempFilePath) {
      // Create a unique filename based on the notebook name
      const notebookName = path.basename(notebook.uri.fsPath, path.extname(notebook.uri.fsPath));
      const uniqueId = Buffer.from(notebookKey).toString('base64').replace(/[/+=]/g, '_').substring(0, 8);
      const fileName = `${notebookName}_${uniqueId}.py`;
      tempFilePath = path.join(this.tempDir, fileName);
      this.tempFiles.set(notebookKey, tempFilePath);
    }

    return vscode.Uri.file(tempFilePath);
  }

  /**
   * Update virtual document for a notebook.
   * Writes cells in dependency order to a temporary file.
   */
  public updateVirtualDocument(notebook: vscode.NotebookDocument): void {
    const virtualUri = this.getVirtualUriForNotebook(notebook);
    const cells = this.topologicalOrderTracker.getCellsInDependencyOrder(notebook);

    const mappings: CellPosition[] = [];
    const lines: string[] = [];
    let currentLine = 0;

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];

      // Only include code cells
      if (cell.kind !== vscode.NotebookCellKind.Code) {
        continue;
      }

      const cellId = getNotebookCellId(cell);
      const code = getCellExecutableCode(cell);
      const cellLines = code.split("\n");

      const startLine = currentLine;

      // Add cell code
      lines.push(...cellLines);
      currentLine += cellLines.length;

      // Add blank line between cells for readability
      lines.push("");
      currentLine++;

      const endLine = currentLine;

      mappings.push({
        cellId,
        cellIndex: cell.index,
        cell,
        virtualStartLine: startLine,
        virtualEndLine: endLine,
      });
    }

    const content = lines.join("\n");

    // Write to temp file
    fs.writeFileSync(virtualUri.fsPath, content, "utf-8");

    // Update cache
    this.cellMappings.set(virtualUri.toString(), mappings);

    lspProxyLogger.log("VirtualDocumentProvider", `Updated virtual document: ${virtualUri.fsPath} (${content.length} bytes, ${lines.length} lines)`);
  }

  /**
   * Convert a position in the virtual document to a notebook cell position.
   */
  public virtualPositionToCellPosition(
    virtualUri: vscode.Uri,
    position: vscode.Position
  ): { cell: vscode.NotebookCell; position: vscode.Position } | undefined {
    const mappings = this.cellMappings.get(virtualUri.toString());
    if (!mappings) {
      return undefined;
    }

    // Find which cell this line belongs to
    for (const mapping of mappings) {
      if (
        position.line >= mapping.virtualStartLine &&
        position.line < mapping.virtualEndLine
      ) {
        const cellLine = position.line - mapping.virtualStartLine;
        return {
          cell: mapping.cell,
          position: new vscode.Position(cellLine, position.character),
        };
      }
    }

    return undefined;
  }

  /**
   * Convert a notebook cell position to a virtual document position.
   */
  public cellPositionToVirtualPosition(
    notebook: vscode.NotebookDocument,
    cell: vscode.NotebookCell,
    position: vscode.Position
  ): vscode.Position | undefined {
    const cellId = getNotebookCellId(cell);
    const virtualUri = this.getVirtualUriForNotebook(notebook);
    const mappings = this.cellMappings.get(virtualUri.toString());
    if (!mappings) {
      return undefined;
    }

    const mapping = mappings.find((m) => m.cellId === cellId);
    if (!mapping) {
      return undefined;
    }

    const virtualLine = mapping.virtualStartLine + position.line;
    return new vscode.Position(virtualLine, position.character);
  }

  /**
   * Get all cell mappings for a virtual document.
   */
  public getCellMappings(virtualUri: vscode.Uri): CellPosition[] | undefined {
    return this.cellMappings.get(virtualUri.toString());
  }

  /**
   * Clear virtual document (e.g., when notebook closes).
   */
  public clearVirtualDocument(notebook: vscode.NotebookDocument): void {
    const notebookKey = notebook.uri.toString();
    const tempFilePath = this.tempFiles.get(notebookKey);

    if (tempFilePath) {
      // Delete the temp file
      try {
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
      } catch (error) {
        lspProxyLogger.log("VirtualDocumentProvider", `Failed to delete temp file: ${error}`);
      }

      this.tempFiles.delete(notebookKey);
    }

    const virtualUri = this.getVirtualUriForNotebook(notebook);
    this.cellMappings.delete(virtualUri.toString());
  }

  /**
   * Check if a virtual document exists for a notebook.
   */
  public hasVirtualDocument(notebook: vscode.NotebookDocument): boolean {
    const notebookKey = notebook.uri.toString();
    return this.tempFiles.has(notebookKey);
  }

  /**
   * Dispose of resources and clean up temp directory.
   */
  public dispose(): void {
    lspProxyLogger.log("VirtualDocumentProvider", "Cleaning up temp directory...");

    // Delete all temp files
    for (const [notebookKey, tempFilePath] of this.tempFiles.entries()) {
      try {
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
      } catch (error) {
        lspProxyLogger.log("VirtualDocumentProvider", `Failed to delete temp file: ${error}`);
      }
    }

    // Delete the temp directory
    try {
      if (fs.existsSync(this.tempDir)) {
        fs.rmdirSync(this.tempDir);
      }
    } catch (error) {
      lspProxyLogger.log("VirtualDocumentProvider", `Failed to delete temp directory: ${error}`);
    }

    this.tempFiles.clear();
    this.cellMappings.clear();
  }
}
