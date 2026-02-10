import type * as vscode from "vscode";
import type * as lsp from "vscode-languageclient/node";

import {
  Effect,
  HashMap,
  Option,
  Runtime,
  type Scope,
  Stream,
  SynchronizedRef,
} from "effect";

import { MarimoNotebookDocument, type NotebookId } from "../../schemas.ts";
import { getTopologicalCells } from "../../utils/getTopologicalCells.ts";
import { Constants } from "../Constants.ts";
import { VariablesService } from "../variables/VariablesService.ts";
import { VsCode } from "../VsCode.ts";

/**
 * Creates a transform function that extends notebook document sync selectors
 * to include additional cell languages.
 *
 * NOTE: Mutates the capabilities object in-place.
 *
 * @internal Exported for testing
 */
export function extendNotebookCellLanguages(
  language: string,
): (capabilities: lsp.ServerCapabilities) => lsp.ServerCapabilities {
  return (capabilities) => {
    const sync = capabilities.notebookDocumentSync;
    if (sync && "notebookSelector" in sync) {
      for (const selector of sync.notebookSelector) {
        if ("cells" in selector && selector.cells) {
          selector.cells.push({ language });
        }
      }
    }
    return capabilities;
  };
}

/**
 * Per-client cell counts: HashMap<NotebookId, number>
 * Each client tracks its own server's cell state to avoid interference.
 */
type CellCountsMap = HashMap.HashMap<NotebookId, number>;

/**
 * Isolated sync instance for a single LSP client.
 * Contains middleware to spread into LanguageClientOptions and
 * a connect method to start variable subscription.
 */
export interface ClientNotebookSync {
  /** Helper to translate notebook documents for server */
  adapter: NotebookAdapter;

  /** Middleware to spread into LanguageClientOptions */
  notebookMiddleware: lsp.Middleware["notebooks"];

  /** Connect the client - starts variable subscription, auto-cleanup on scope close */
  connect(client: lsp.LanguageClient): Effect.Effect<void, never, Scope.Scope>;
}

/**
 * Service that manages notebook synchronization for multiple LSP clients.
 *
 * This service:
 * 1. Provides the NotebookAdapter for document/cell transformations
 * 2. Creates isolated sync instances for each LSP client via `forClient()`
 *
 * Usage:
 * ```typescript
 * const sync = yield* NotebookSyncService;
 *
 * // Create an isolated sync instance for this client
 * const notebookSync = yield* sync.forClient();
 *
 * const client = new NamespacedLanguageClient(
 *   "marimo-ty",
 *   "marimo (ty)",
 *   serverOptions,
 *   {
 *     ...clientOptions,
 *     middleware: yield* createTyMiddleware(notebookSync.middleware),
 *   },
 * );
 * await client.start();
 *
 * // Connect to start variable subscription
 * yield* notebookSync.connect(client);
 * ```
 */
export class NotebookSyncService extends Effect.Service<NotebookSyncService>()(
  "NotebookSyncService",
  {
    dependencies: [VariablesService.Default, Constants.Default],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const variables = yield* VariablesService;
      const { LanguageId } = yield* Constants;

      const workspaceFolders = yield* code.workspace.getWorkspaceFolders();

      return {
        /**
         * Creates document selector for language server clients.
         */
        getDocumentSelector() {
          if (isVirtualWorkspace(workspaceFolders)) {
            return [{ language: LanguageId.Python }];
          }

          return [
            { scheme: "file", language: LanguageId.Python },
            { scheme: "untitled", language: LanguageId.Python },
            { scheme: "vscode-notebook", language: LanguageId.Python },
            { scheme: "vscode-notebook-cell", language: LanguageId.Python },
          ];
        },

        /**
         * Creates a transform function that extends notebook document sync selectors
         * to include additional cell languages.
         *
         * NOTE: Mutates the capabilities object in-place.
         */
        extendNotebookCellLanguages(): (
          capabilities: lsp.ServerCapabilities,
        ) => lsp.ServerCapabilities {
          return extendNotebookCellLanguages(LanguageId.Python);
        },

        /**
         * Create an isolated sync instance for a client.
         * Each client gets its own cell count tracking to avoid interference.
         *
         * @param opts.transformNotebookDocumentUri - Optional function to transform notebook
         *   document URIs before sending to the LSP server. Some servers (like Ruff) require
         *   the URI to end with `.ipynb` to recognize it as a notebook. If not provided,
         *   URIs are passed through unchanged.
         */
        forClient(): Effect.Effect<ClientNotebookSync, never, Scope.Scope> {
          const adapter = new NotebookAdapter(LanguageId.Python);
          return Effect.gen(function* () {
            const cellCountsRef = yield* SynchronizedRef.make<CellCountsMap>(
              HashMap.empty(),
            );
            return {
              adapter,
              notebookMiddleware: yield* createNotebookMiddleware(
                adapter,
                cellCountsRef,
              ).pipe(Effect.provideService(VariablesService, variables)),
              connect: (client: lsp.LanguageClient) =>
                variables.notebookUpdates().pipe(
                  Stream.filter((evt) => evt.kind === "declaration"),
                  Stream.mapEffect((evt) =>
                    sendResyncNotification(
                      client,
                      cellCountsRef,
                      adapter,
                      evt.notebookId,
                    ),
                  ),
                  Stream.runDrain,
                  Effect.forkScoped,
                  Effect.provideService(VsCode, code),
                  Effect.provideService(VariablesService, variables),
                ),
            };
          });
        },
      };
    }),
  },
) {}

/**
 * Sends a resync notification to a client for a specific notebook.
 */
const sendResyncNotification = Effect.fn(function* (
  client: lsp.LanguageClient,
  cellCountsRef: SynchronizedRef.SynchronizedRef<CellCountsMap>,
  adapter: NotebookAdapter,
  notebookId: NotebookId,
) {
  const code = yield* VsCode;
  const notebooks = yield* code.workspace.getNotebookDocuments();

  // Find the notebook document for this ID
  const raw = notebooks.find((nb) => {
    const doc = MarimoNotebookDocument.tryFrom(nb);
    return Option.isSome(doc) && doc.value.id === notebookId;
  });

  if (!raw) {
    return;
  }

  const doc = MarimoNotebookDocument.tryFrom(raw);
  if (Option.isNone(doc)) {
    return;
  }

  const notification = yield* buildResyncNotification(
    doc.value,
    adapter,
    cellCountsRef,
  );

  if (Option.isNone(notification)) {
    return;
  }

  yield* Effect.promise(() =>
    client.sendNotification("notebookDocument/didChange", notification.value),
  );
});

/**
 * Adapts marimo notebook documents and cells for LSP server compatibility.
 *
 * Responsibilities:
 * - Optionally transform notebook document URIs (some servers need `.ipynb` suffix)
 * - Normalize mo-python -> python language ID
 * - NOT modify cell URIs (they should stay as-is)
 *
 * @internal Exported for testing
 */
export class NotebookAdapter {
  #pythonLanguageId: string;

  constructor(pythonLanguageId: string) {
    this.#pythonLanguageId = pythonLanguageId;
  }

  #resolveLanguageId(languageId: string): string {
    return languageId === this.#pythonLanguageId ? "python" : languageId;
  }

  /** Optionally transforms the notebook document URI using the configured transform. */
  notebookDocument<T extends { uri: vscode.Uri }>(doc: T): T {
    // no-op
    return doc;
  }

  /**
   * Creates a document wrapper that normalizes mo-python to python.
   * Does NOT modify the URI - cell URIs should stay as-is so the server doesn't
   * mistake them for notebook documents.
   */
  document<T extends { languageId: string }>(document: T): T {
    const wrapped = Object.create(document);
    Object.defineProperty(wrapped, "languageId", {
      value: this.#resolveLanguageId(document.languageId),
      enumerable: true,
      configurable: true,
    });
    return wrapped;
  }

  /**
   * Adapts a notebook cell for notebook document sync messages.
   * - Transforms the notebook URI to include .ipynb
   * - Normalizes the cell document language ID (but NOT the URI)
   */
  cell(cell: vscode.NotebookCell): vscode.NotebookCell {
    return {
      ...cell,
      notebook: this.notebookDocument(cell.notebook),
      document: this.document(cell.document),
    };
  }

  /** Normalizes mo-python to python on all cells in a notebook change event. */
  cellsEvent(
    cells: lsp.VNotebookDocumentChangeEvent["cells"],
  ): lsp.VNotebookDocumentChangeEvent["cells"] {
    if (!cells) {
      return undefined;
    }

    const result: lsp.VNotebookDocumentChangeEvent["cells"] = {};
    const { textContent, data, structure } = cells;

    if (textContent) {
      result.textContent = textContent.map((change) => ({
        ...change,
        document: this.document(change.document),
      }));
    }

    if (data) {
      result.data = data.map((cell) => this.cell(cell));
    }

    if (structure) {
      result.structure = {
        array: {
          ...structure.array,
          cells: structure.array.cells?.map((cell) => this.cell(cell)),
        },
        didOpen: structure.didOpen?.map((cell) => this.cell(cell)),
        didClose: structure.didClose?.map((cell) => this.cell(cell)),
      };
    }

    return result;
  }
}

/**
 * Checks if all workspace folders are virtual (non-file scheme).
 */
function isVirtualWorkspace(
  workspaceFolders: Option.Option<ReadonlyArray<vscode.WorkspaceFolder>>,
): boolean {
  return Option.match(workspaceFolders, {
    onSome: (folders) => folders.every((f) => f.uri.scheme !== "file"),
    onNone: () => false,
  });
}

/**
 * Build a resync notification for a notebook when cell order changes.
 * Returns None if no resync is needed.
 *
 * Uses SynchronizedRef.modifyEffect to atomically get previous count,
 * fetch reordered cells, and update the count - serializing with other
 * notebook operations.
 */
function buildResyncNotification(
  doc: MarimoNotebookDocument,
  adapter: NotebookAdapter,
  cellCountsRef: SynchronizedRef.SynchronizedRef<CellCountsMap>,
) {
  return SynchronizedRef.modifyEffect(cellCountsRef, (cellCounts) =>
    Effect.gen(function* () {
      const previousCellCount = Option.getOrElse(
        HashMap.get(cellCounts, doc.id),
        () => 0,
      );

      const reorderedCells = yield* getTopologicalCells(doc);

      if (reorderedCells.length === 0 && previousCellCount === 0) {
        return [Option.none(), cellCounts] as const;
      }

      // Track the count of cells we actually send, not doc.cellCount
      const newCellCounts = HashMap.set(
        cellCounts,
        doc.id,
        reorderedCells.length,
      );

      const transformedCells = adapter.cellsEvent({
        structure: {
          array: {
            start: 0,
            deleteCount: previousCellCount,
            cells: reorderedCells,
          },
          didOpen: reorderedCells,
          didClose: [],
        },
      });

      const structure = transformedCells?.structure;
      if (!structure) {
        return [Option.none(), newCellCounts] as const;
      }

      const notebookDoc = adapter.notebookDocument(doc.rawNotebookDocument);

      const notification = Option.some({
        notebookDocument: {
          uri: notebookDoc.uri.toString(),
          version: notebookDoc.version,
        },
        change: {
          cells: {
            structure: {
              array: {
                start: structure.array.start,
                deleteCount: structure.array.deleteCount,
                cells: structure.array.cells?.map((cell) => ({
                  kind: cell.kind,
                  document: cell.document.uri.toString(),
                })),
              } satisfies lsp.NotebookCellArrayChange,
              didOpen: structure.didOpen?.map((cell) => ({
                uri: cell.document.uri.toString(),
                languageId: cell.document.languageId,
                version: cell.document.version,
                text: cell.document.getText(),
              })),
              didClose: structure.didClose?.map((cell) => ({
                uri: cell.document.uri.toString(),
              })),
            },
          },
        },
      });

      return [notification, newCellCounts] as const;
    }),
  );
}

/**
 * Creates notebook middleware for a client.
 * Uses its own cellCountsRef for isolation.
 */
function createNotebookMiddleware(
  adapter: NotebookAdapter,
  cellCountsRef: SynchronizedRef.SynchronizedRef<CellCountsMap>,
) {
  return Effect.gen(function* () {
    const runtime = yield* Effect.runtime<VariablesService>();
    const runPromise = Runtime.runPromise(runtime);

    const notebookMiddleware: lsp.Middleware["notebooks"] = {
      didOpen: async (raw, _cells, next) => {
        const doc = MarimoNotebookDocument.from(raw);
        // SynchronizedRef.modifyEffect serializes with other operations
        const orderedCells = await runPromise(
          SynchronizedRef.modifyEffect(cellCountsRef, (cellCounts) =>
            Effect.map(getTopologicalCells(doc), (cells) => {
              const newCellCounts = HashMap.set(
                cellCounts,
                doc.id,
                cells.length,
              );
              return [cells, newCellCounts];
            }),
          ),
        );
        return next(
          adapter.notebookDocument(raw),
          orderedCells.map((cell) => adapter.cell(cell)),
        );
      },
      didClose: async (raw, _cells, next) => {
        const doc = MarimoNotebookDocument.from(raw);
        // SynchronizedRef.modifyEffect serializes with other operations
        const orderedCells = await runPromise(
          SynchronizedRef.modifyEffect(cellCountsRef, (cellCounts) =>
            Effect.map(getTopologicalCells(doc), (cells) => {
              const newCellCounts = HashMap.remove(cellCounts, doc.id);
              return [cells, newCellCounts];
            }),
          ),
        );
        return next(
          adapter.notebookDocument(raw),
          orderedCells.map((cell) => adapter.cell(cell)),
        );
      },
      didChange: async (event, next) => {
        const doc = MarimoNotebookDocument.from(event.notebook);
        const result = await runPromise(
          buildCellReplacement(doc, cellCountsRef, event.cells),
        );
        return next({
          notebook: adapter.notebookDocument(event.notebook),
          metadata: event.metadata,
          cells: adapter.cellsEvent(result),
        });
      },
    };

    return notebookMiddleware;
  });
}

/**
 * Transforms a notebook structure change into an LSP-compatible format that
 * replaces all cells with their topologically-sorted order.
 *
 * Rather than applying incremental changes, this deletes all existing cells
 * and re-inserts them in topological order. All cells are included in `didOpen`
 * so the LSP server receives their full text content.
 *
 * Uses SynchronizedRef.modifyEffect to serialize with other notebook operations.
 */
function buildCellReplacement(
  doc: MarimoNotebookDocument,
  cellCountsRef: SynchronizedRef.SynchronizedRef<CellCountsMap>,
  cells: lsp.VNotebookDocumentChangeEvent["cells"],
): Effect.Effect<
  lsp.VNotebookDocumentChangeEvent["cells"],
  never,
  VariablesService
> {
  // No structure change - pass through without locking
  if (!cells?.structure) {
    return Effect.succeed(cells);
  }

  // Delete all old cells, insert all in new order.
  // We must provide ALL cells in didOpen so the server gets their text content.
  return SynchronizedRef.modifyEffect(cellCountsRef, (cellCounts) =>
    Effect.map(getTopologicalCells(doc), (reorderedCells) => {
      const prevCount = Option.getOrElse(
        HashMap.get(cellCounts, doc.id),
        () => 0,
      );
      // Track the count of cells we actually send, not doc.cellCount
      const newCellCounts = HashMap.set(
        cellCounts,
        doc.id,
        reorderedCells.length,
      );

      const result: lsp.VNotebookDocumentChangeEvent["cells"] = {
        structure: {
          array: {
            start: 0,
            deleteCount: prevCount,
            cells: reorderedCells,
          },
          didOpen: reorderedCells,
          didClose: [],
        },
      };

      return [result, newCellCounts] as const;
    }),
  );
}
