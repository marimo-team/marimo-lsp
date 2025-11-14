import * as vscode from "vscode";
import { TopologicalOrderTracker } from "./TopologicalOrderTracker";
import { VirtualDocumentProvider } from "./VirtualDocumentProvider";
import { PyrightProxy } from "./PyrightProxy";
import { NOTEBOOK_TYPE } from "../../constants";
import { lspProxyLogger } from "./LspProxyLogger";

/**
 * Coordinates LSP integration for marimo notebooks.
 *
 * This service:
 * 1. Tracks cell dependency order using topological sorting
 * 2. Maintains virtual documents for Pyright integration
 * 3. Updates virtual documents when cells change or variables change
 * 4. Provides language features via Pyright proxy
 */
export class NotebookLspCoordinator {
  private disposables: vscode.Disposable[] = [];
  private topologicalOrderTracker: TopologicalOrderTracker;
  private virtualDocumentProvider: VirtualDocumentProvider;
  private pyrightProxy: PyrightProxy;

  constructor(
    topologicalOrderTracker: TopologicalOrderTracker,
    virtualDocumentProvider: VirtualDocumentProvider,
    pyrightProxy: PyrightProxy
  ) {
    this.topologicalOrderTracker = topologicalOrderTracker;
    this.virtualDocumentProvider = virtualDocumentProvider;
    this.pyrightProxy = pyrightProxy;
    this.setupEventHandlers();
  }

  /**
   * Set up event handlers for notebook lifecycle.
   */
  private setupEventHandlers(): void {
    // Handle notebook open
    this.disposables.push(
      vscode.workspace.onDidOpenNotebookDocument(async (notebook) => {
        if (notebook.notebookType === NOTEBOOK_TYPE) {
          await this.handleNotebookOpened(notebook);
        }
      })
    );

    // Handle notebook close
    this.disposables.push(
      vscode.workspace.onDidCloseNotebookDocument((notebook) => {
        if (notebook.notebookType === NOTEBOOK_TYPE) {
          this.handleNotebookClosed(notebook);
        }
      })
    );

    // Handle notebook changes (cell edits, adds, deletes, moves)
    this.disposables.push(
      vscode.workspace.onDidChangeNotebookDocument(async (event) => {
        if (event.notebook.notebookType === NOTEBOOK_TYPE) {
          await this.handleNotebookChanged(event);
        }
      })
    );

    // Initialize already-open notebooks
    const openNotebooks = vscode.workspace.notebookDocuments.filter(nb => nb.notebookType === NOTEBOOK_TYPE);
    for (const notebook of openNotebooks) {
      this.handleNotebookOpened(notebook);
    }
  }

  /**
   * Handle notebook opened.
   */
  private async handleNotebookOpened(
    notebook: vscode.NotebookDocument
  ): Promise<void> {
    // Initialize topological order tracker
    this.topologicalOrderTracker.initializeNotebook(notebook);

    // Initialize Pyright proxy with virtual document
    await this.pyrightProxy.initializeNotebook(notebook);
  }

  /**
   * Handle notebook closed.
   */
  private handleNotebookClosed(notebook: vscode.NotebookDocument): void {
    // Clean up topological order tracker
    this.topologicalOrderTracker.clearNotebook(notebook);

    // Clean up Pyright proxy
    this.pyrightProxy.closeNotebook(notebook);
  }

  /**
   * Handle notebook content changes.
   */
  private async handleNotebookChanged(
    event: vscode.NotebookDocumentChangeEvent
  ): Promise<void> {
    let shouldUpdate = false;

    // Check if cells were structurally changed (added, removed, moved)
    if (event.cellChanges.length > 0) {
      this.topologicalOrderTracker.handleCellsChanged(
        event.notebook,
        event.cellChanges
      );
      shouldUpdate = true;
    }

    // Check if cell content changed
    if (event.contentChanges.length > 0) {
      shouldUpdate = true;
    }

    // Update virtual document if needed
    if (shouldUpdate) {
      await this.pyrightProxy.updateNotebook(event.notebook);
    }
  }


  /**
   * Register language feature providers for notebook cells.
   */
  public registerLanguageFeatureProviders(): void {
    const cellDocumentSelector: vscode.DocumentSelector = {
      notebookType: NOTEBOOK_TYPE,
      language: "python",
    };

    // Register completion provider
    this.disposables.push(
      vscode.languages.registerCompletionItemProvider(
        cellDocumentSelector,
        {
          provideCompletionItems: (document, position, token, context) => {
            const match = vscode.languages.match(cellDocumentSelector, document);
            lspProxyLogger.log("Completion requested", `match = ${match}`);

            return this.pyrightProxy.provideCompletionItems(
              document,
              position,
              token,
              context
            );
          },
        },
        ".", // Trigger on dot
        "(" // Trigger on open paren
      )
    );

    // Register hover provider
    this.disposables.push(
      vscode.languages.registerHoverProvider(cellDocumentSelector, {
        provideHover: (document, position, token) => {
          return this.pyrightProxy.provideHover(document, position, token);
        },
      })
    );

    // Register definition provider
    this.disposables.push(
      vscode.languages.registerDefinitionProvider(cellDocumentSelector, {
        provideDefinition: (document, position, token) => {
          return this.pyrightProxy.provideDefinition(document, position, token);
        },
      })
    );

    // Register signature help provider
    this.disposables.push(
      vscode.languages.registerSignatureHelpProvider(
        cellDocumentSelector,
        {
          provideSignatureHelp: (document, position, token, context) => {
            return this.pyrightProxy.provideSignatureHelp(
              document,
              position,
              token,
              context
            );
          },
        },
        "(", // Trigger on open paren
        "," // Trigger on comma
      )
    );
  }

  /**
   * Dispose of resources.
   */
  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    this.pyrightProxy.dispose();
  }
}
