import * as vscode from "vscode";
import { VirtualDocumentProvider } from "./VirtualDocumentProvider";
import { TopologicalOrderTracker } from "./TopologicalOrderTracker";
import { getNotebookCellId } from "../../utils/notebook";
import { lspProxyLogger } from "./LspProxyLogger";

/**
 * Proxies language features from Pyright to notebook cells.
 *
 * This service creates virtual documents that represent notebooks in dependency
 * order, then delegates language features (completions, hover, etc.) from
 * notebook cells to the virtual document where Pyright can analyze them correctly.
 */
export class PyrightProxy {
  private virtualDocuments: Map<string, vscode.TextDocument> = new Map();
  private hiddenEditors: Map<string, vscode.TextEditor> = new Map(); // Keep editors open for Pylance
  private disposables: vscode.Disposable[] = [];
  private virtualDocumentProvider: VirtualDocumentProvider;
  private topologicalOrderTracker: TopologicalOrderTracker;

  constructor(
    virtualDocumentProvider: VirtualDocumentProvider,
    topologicalOrderTracker: TopologicalOrderTracker
  ) {
    this.virtualDocumentProvider = virtualDocumentProvider;
    this.topologicalOrderTracker = topologicalOrderTracker;
  }

  /**
   * Initialize proxy for a notebook.
   * Creates and opens the virtual document.
   */
  public async initializeNotebook(
    notebook: vscode.NotebookDocument
  ): Promise<void> {
    lspProxyLogger.log("PyrightProxy", `Initializing notebook: ${notebook.uri.toString()}`);

    // Update virtual document content (writes to temp file)
    this.virtualDocumentProvider.updateVirtualDocument(notebook);

    // Open the temp file
    const virtualUri = this.virtualDocumentProvider.getVirtualUriForNotebook(notebook);

    try {
      // Open the temp file
      const virtualDoc = await vscode.workspace.openTextDocument(virtualUri);
      this.virtualDocuments.set(notebook.uri.toString(), virtualDoc);

      // CRITICAL: Open the file in a hidden editor to trigger Pylance analysis
      // Pylance only analyzes files that are opened in an editor
      const activeEditor = vscode.window.activeTextEditor;

      // Open in background column
      const editor = await vscode.window.showTextDocument(virtualDoc, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
        preview: false
      });

      // Store the editor reference to keep it open
      this.hiddenEditors.set(notebook.uri.toString(), editor);

      // Immediately switch back to the original editor
      if (activeEditor) {
        await vscode.window.showTextDocument(activeEditor.document, {
          viewColumn: activeEditor.viewColumn,
          preserveFocus: false
        });
      }

      // Wait for Pylance to analyze
      await new Promise(resolve => setTimeout(resolve, 1000));

      lspProxyLogger.log("PyrightProxy", `Opened virtual document in background editor: ${virtualUri.fsPath}`);
    } catch (error) {
      lspProxyLogger.log("PyrightProxy", "Failed to open temp file:", error);
    }
  }


  /**
   * Update virtual document when notebook changes.
   */
  public async updateNotebook(notebook: vscode.NotebookDocument): Promise<void> {
    // Write updated content to temp file
    this.virtualDocumentProvider.updateVirtualDocument(notebook);

    // The temp file content has changed, but the hidden editor already has it open
    // VS Code will automatically reload the file content since it changed on disk
    // Pylance will re-analyze automatically
  }

  /**
   * Close virtual document when notebook closes.
   */
  public closeNotebook(notebook: vscode.NotebookDocument): void {
    const notebookUri = notebook.uri.toString();

    // Close the hidden editor if it exists
    const hiddenEditor = this.hiddenEditors.get(notebookUri);
    if (hiddenEditor) {
      // Close the editor by executing the close command on its document
      vscode.window.showTextDocument(hiddenEditor.document).then(() => {
        vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      });
      this.hiddenEditors.delete(notebookUri);
    }

    this.virtualDocuments.delete(notebookUri);
    this.virtualDocumentProvider.clearVirtualDocument(notebook);
  }

  /**
   * Get virtual document for a notebook.
   */
  public getVirtualDocument(
    notebook: vscode.NotebookDocument
  ): vscode.TextDocument | undefined {
    return this.virtualDocuments.get(notebook.uri.toString());
  }

  /**
   * Provide completions for a notebook cell by delegating to Pyright.
   */
  public async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[] | vscode.CompletionList | undefined> {
    const notebook = this.getNotebookForCell(document.uri);
    if (!notebook) {
      lspProxyLogger.warn("PyrightProxy", `No notebook found for document: ${document.uri.toString()}`);
      return undefined;
    }

    const cell = this.getCellForDocument(notebook, document.uri);
    if (!cell) {
      lspProxyLogger.warn("PyrightProxy", `No cell found for document: ${document.uri.toString()}`);
      return undefined;
    }

    const virtualDoc = this.getVirtualDocument(notebook);
    if (!virtualDoc) {
      lspProxyLogger.warn("PyrightProxy", `No virtual document found for notebook: ${notebook.uri.toString()}`);
      return undefined;
    }

    // Map cell position to virtual document position
    const virtualPosition =
      this.virtualDocumentProvider.cellPositionToVirtualPosition(
        notebook,
        cell,
        position
      );

    if (!virtualPosition) {
      lspProxyLogger.log("PyrightProxy", `Failed to map cell position to virtual document position for cell: ${getNotebookCellId(cell)}`);
      return undefined;
    }

    // Delegate to VS Code's completion provider (Pyright)
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      virtualDoc.uri,
      virtualPosition,
      context.triggerCharacter
    );

    if (!completions || completions.items.length === 0) {
      lspProxyLogger.log("PyrightProxy", `No completions returned for cell: ${getNotebookCellId(cell)}`);
      return undefined;
    }

    lspProxyLogger.log("PyrightProxy", `Completions returned for cell ${getNotebookCellId(cell)}: ${completions.items.length}`);
    lspProxyLogger.log("PyrightProxy", `Completions: ${completions.items.map(item => item.label).join(", ")}`);

    return completions;
  }

  /**
   * Provide hover information for a notebook cell.
   */
  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    const notebook = this.getNotebookForCell(document.uri);
    if (!notebook) {
      return undefined;
    }

    const cell = this.getCellForDocument(notebook, document.uri);
    if (!cell) {
      return undefined;
    }

    const virtualDoc = this.getVirtualDocument(notebook);
    if (!virtualDoc) {
      return undefined;
    }

    // Map cell position to virtual document position
    const virtualPosition =
      this.virtualDocumentProvider.cellPositionToVirtualPosition(
        notebook,
        cell,
        position
      );

    if (!virtualPosition) {
      return undefined;
    }

    // Delegate to VS Code's hover provider (Pyright)
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      virtualDoc.uri,
      virtualPosition
    );
    lspProxyLogger.log("PyrightProxy", `Hovers returned: ${hovers?.length}`);

    if (!hovers || hovers.length === 0) {
      const noHover = new vscode.Hover("No hover information available.");
      return noHover;
    }

    // Return the first hover (VS Code combines them)
    return hovers[0];
  }

  /**
   * Provide definition for a symbol in a notebook cell.
   */
  public async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Definition | undefined> {
    const notebook = this.getNotebookForCell(document.uri);
    if (!notebook) {
      return undefined;
    }

    const cell = this.getCellForDocument(notebook, document.uri);
    if (!cell) {
      return undefined;
    }

    const virtualDoc = this.getVirtualDocument(notebook);
    if (!virtualDoc) {
      return undefined;
    }

    // Map cell position to virtual document position
    const virtualPosition =
      this.virtualDocumentProvider.cellPositionToVirtualPosition(
        notebook,
        cell,
        position
      );

    if (!virtualPosition) {
      return undefined;
    }

    // Delegate to VS Code's definition provider (Pyright)
    const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeDefinitionProvider",
      virtualDoc.uri,
      virtualPosition
    );

    if (!definitions || definitions.length === 0) {
      return undefined;
    }

    // Map definitions back to notebook cells
    const mappedDefinitions: vscode.Location[] = [];

    for (const definition of definitions) {
      // Check if definition is in our temp file
      const virtualUri = this.virtualDocumentProvider.getVirtualUriForNotebook(notebook);
      if (definition.uri.toString() === virtualUri.toString()) {
        // Map back to notebook cell
        const cellPosition =
          this.virtualDocumentProvider.virtualPositionToCellPosition(
            definition.uri,
            definition.range.start
          );

        if (cellPosition) {
          mappedDefinitions.push(
            new vscode.Location(cellPosition.cell.document.uri, cellPosition.position)
          );
        }
      } else {
        // External file, keep as-is
        mappedDefinitions.push(definition);
      }
    }

    return mappedDefinitions.length > 0 ? mappedDefinitions : undefined;
  }

  /**
   * Provide signature help for a notebook cell.
   */
  public async provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.SignatureHelpContext
  ): Promise<vscode.SignatureHelp | undefined> {
    const notebook = this.getNotebookForCell(document.uri);
    if (!notebook) {
      return undefined;
    }

    const cell = this.getCellForDocument(notebook, document.uri);
    if (!cell) {
      return undefined;
    }

    const virtualDoc = this.getVirtualDocument(notebook);
    if (!virtualDoc) {
      return undefined;
    }

    // Map cell position to virtual document position
    const virtualPosition =
      this.virtualDocumentProvider.cellPositionToVirtualPosition(
        notebook,
        cell,
        position
      );

    if (!virtualPosition) {
      return undefined;
    }

    // Delegate to VS Code's signature help provider (Pyright)
    const signatureHelp = await vscode.commands.executeCommand<vscode.SignatureHelp>(
      "vscode.executeSignatureHelpProvider",
      virtualDoc.uri,
      virtualPosition,
      context.triggerCharacter
    );

    return signatureHelp;
  }

  /**
   * Helper: Get notebook for a cell document URI.
   */
  private getNotebookForCell(cellUri: vscode.Uri): vscode.NotebookDocument | undefined {
    // Cell URIs are of the form: notebook-uri#cellId
    for (const notebook of vscode.workspace.notebookDocuments) {
      for (const cell of notebook.getCells()) {
        if (cell.document.uri.toString() === cellUri.toString()) {
          return notebook;
        }
      }
    }
    return undefined;
  }

  /**
   * Helper: Get cell for a document URI within a notebook.
   */
  private getCellForDocument(
    notebook: vscode.NotebookDocument,
    cellUri: vscode.Uri
  ): vscode.NotebookCell | undefined {
    return notebook
      .getCells()
      .find((cell) => cell.document.uri.toString() === cellUri.toString());
  }

  /**
   * Dispose of resources.
   */
  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }
}
