import { Effect, HashMap, HashSet, Option, Ref, Runtime, Stream } from "effect";
import type * as vscode from "vscode";
import type * as lsp from "vscode-languageclient/node";
import { MarimoNotebookDocument, type NotebookId } from "../../schemas.ts";
import { getTopologicalCells } from "../../utils/getTopologicalCells.ts";
import type { NamespacedLanguageClient } from "../../utils/NamespacedLanguageClient.ts";
import { Constants } from "../Constants.ts";
import { VsCode } from "../VsCode.ts";
import { VariablesService } from "../variables/VariablesService.ts";

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
 * Service that manages notebook synchronization for multiple LSP clients.
 *
 * This service:
 * 1. Provides the NotebookAdapter for document/cell transformations
 * 2. Provides notebook middleware for LSP clients
 * 3. Manages client registration for resync broadcasts
 * 4. Listens to variable changes and broadcasts resync events to all registered clients
 *
 * Usage:
 * ```typescript
 * const sync = yield* NotebookSyncService;
 *
 * // Use the adapter for document transformations
 * const doc = sync.adapter.document(originalDoc);
 *
 * // Get middleware to spread into your client options
 * const middleware = {
 *   ...sync.notebookMiddleware,
 *   // Add server-specific middleware...
 * };
 *
 * // Register client for resync broadcasts (auto-unregisters when scope closes)
 * yield* sync.registerClient(client);
 * ```
 */
export class NotebookSyncService extends Effect.Service<NotebookSyncService>()(
  "NotebookSyncService",
  {
    dependencies: [VariablesService.Default],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const variablesService = yield* VariablesService;
      const { LanguageId } = yield* Constants;

      const adapter = new NotebookAdapter(LanguageId.Python);

      const cellCountsRef = yield* Ref.make(
        HashMap.empty<NotebookId, number>(),
      );
      const clientsRef = yield* Ref.make(
        HashSet.empty<NamespacedLanguageClient>(),
      );

      // Start the resync broadcaster
      yield* Effect.forkScoped(
        variablesService.streamVariablesChanges().pipe(
          Stream.mapEffect((change) =>
            handleVariablesChange(clientsRef, cellCountsRef, adapter, change),
          ),
          Stream.runDrain,
        ),
      );

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

        /** The NotebookAdapter for document/cell transformations */
        adapter,

        /** Middleware to spread into LSP client options */
        notebookMiddleware: yield* createNotebookMiddleware(
          adapter,
          cellCountsRef,
        ),

        /**
         * Register a client to receive resync broadcasts.
         * Automatically unregisters when the scope closes.
         */
        registerClient(client: NamespacedLanguageClient) {
          return Effect.acquireRelease(
            Ref.update(clientsRef, HashSet.add(client)),
            () => Ref.update(clientsRef, HashSet.remove(client)),
          );
        },
      };
    }),
  },
) {}

/**
 * Handle a variable change event by resyncing affected notebooks.
 */
const handleVariablesChange = Effect.fn(function* (
  clientsRef: Ref.Ref<HashSet.HashSet<NamespacedLanguageClient>>,
  cellCountsRef: Ref.Ref<HashMap.HashMap<NotebookId, number>>,
  adapter: NotebookAdapter,
  variablesMap: HashMap.HashMap<NotebookId, unknown>,
) {
  const code = yield* VsCode;

  const clients = yield* Ref.get(clientsRef);

  if (HashSet.size(clients) === 0) {
    return;
  }

  const notebooks = yield* code.workspace.getNotebookDocuments();

  for (const raw of notebooks) {
    const doc = MarimoNotebookDocument.tryFrom(raw);
    if (Option.isNone(doc)) {
      continue;
    }

    // Only resync notebooks that have variable data (meaning they're being tracked)
    if (!HashMap.has(variablesMap, doc.value.id)) {
      continue;
    }

    const notification = yield* buildResyncNotification(
      doc.value,
      adapter,
      cellCountsRef,
    );

    if (Option.isNone(notification)) {
      continue;
    }

    yield* Effect.forEach(
      clients,
      (client) =>
        Effect.promise(() =>
          client.sendNotification(
            "notebookDocument/didChange",
            notification.value,
          ),
        ),
      { concurrency: "unbounded" },
    );
  }
});

/**
 * Adapts marimo notebook documents and cells for LSP server compatibility.
 *
 * Key insight: LSP servers like Ruff and ty use `key_from_url` which checks if a URL path
 * ends with `.ipynb` to determine if it's a notebook. We must:
 * - Append `.ipynb` to the NOTEBOOK document URI so the server treats it as a notebook
 * - NOT append `.ipynb` to CELL document URIs, so they aren't mistaken for notebooks
 * - Normalize mo-python -> python language ID
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

  /** Appends .ipynb to notebook URI so the server recognizes it as a notebook. */
  notebookDocument<T extends { uri: vscode.Uri }>(doc: T): T {
    const wrapped = Object.create(doc);
    Object.defineProperty(wrapped, "uri", {
      value: doc.uri.with({ path: `${doc.uri.path}.ipynb` }),
      enumerable: true,
      configurable: true,
    });
    return wrapped;
  }

  /**
   * Creates a document wrapper that normalizes mo-python to python.
   * Does NOT modify the URI - cell URIs should stay as-is so the server doesn't
   * mistake them for notebook documents.
   */
  document(document: vscode.TextDocument): vscode.TextDocument {
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
 */
const buildResyncNotification = Effect.fn(function* (
  doc: MarimoNotebookDocument,
  adapter: NotebookAdapter,
  cellCounts: Ref.Ref<HashMap.HashMap<NotebookId, number>>,
) {
  const previousCellCount = Option.getOrElse(
    HashMap.get(yield* Ref.get(cellCounts), doc.id),
    () => 0,
  );

  if (doc.cellCount === 0 && previousCellCount === 0) {
    return Option.none();
  }

  const reorderedCells = yield* getTopologicalCells(doc);

  // Update the cell count
  yield* Ref.update(cellCounts, HashMap.set(doc.id, doc.cellCount));

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
    return Option.none();
  }

  const notebookDoc = adapter.notebookDocument(doc.rawNotebookDocument);

  return Option.some({
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
});

function createNotebookMiddleware(
  adapter: NotebookAdapter,
  countsRef: Ref.Ref<HashMap.HashMap<NotebookId, number>>,
) {
  return Effect.gen(function* () {
    const runtime = yield* Effect.runtime<VariablesService>();
    const runPromise = Runtime.runPromise(runtime);

    const notebookMiddleware: Readonly<
      Pick<lsp.Middleware, "didOpen" | "didClose" | "didChange" | "notebooks">
    > = {
      didOpen: (document, next) => next(adapter.document(document)),
      didClose: (document, next) => next(adapter.document(document)),
      didChange: (change, next) =>
        next({ ...change, document: adapter.document(change.document) }),
      notebooks: {
        didOpen: async (raw, _cells, next) => {
          const doc = MarimoNotebookDocument.from(raw);
          const orderedCells = await runPromise(
            Ref.update(countsRef, HashMap.set(doc.id, doc.cellCount)).pipe(
              Effect.andThen(() => getTopologicalCells(doc)),
            ),
          );
          return next(
            adapter.notebookDocument(raw),
            orderedCells.map((cell) => adapter.cell(cell)),
          );
        },
        didClose: async (raw, _cells, next) => {
          const doc = MarimoNotebookDocument.from(raw);
          const orderedCells = await runPromise(
            Ref.update(countsRef, HashMap.remove(doc.id)).pipe(
              Effect.andThen(() => getTopologicalCells(doc)),
            ),
          );
          return next(
            adapter.notebookDocument(raw),
            orderedCells.map((cell) => adapter.cell(cell)),
          );
        },
        didChange: async (event, next) => {
          const doc = MarimoNotebookDocument.from(event.notebook);
          return next({
            notebook: adapter.notebookDocument(event.notebook),
            metadata: event.metadata,
            cells: adapter.cellsEvent(
              await runPromise(
                buildCellReplacement(doc, countsRef, event.cells),
              ),
            ),
          });
        },
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
 */
function buildCellReplacement(
  doc: MarimoNotebookDocument,
  countsRef: Ref.Ref<HashMap.HashMap<NotebookId, number>>,
  cells: lsp.VNotebookDocumentChangeEvent["cells"],
) {
  return Effect.gen(function* () {
    // Delete all old cells, insert all in new order.
    // We must provide ALL cells in didOpen so the server gets their text content.
    if (cells?.structure) {
      const [counts, reorderedCells] = yield* Effect.all(
        [
          // Get the previous map (for deleteCount) while storing the new count
          Ref.getAndUpdate(countsRef, HashMap.set(doc.id, doc.cellCount)),
          getTopologicalCells(doc),
        ],
        { concurrency: "unbounded" },
      );

      const prevCount = HashMap.get(counts, doc.id).pipe(
        Option.getOrElse(() => 0),
      );

      return {
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
    }

    return cells;
  });
}
