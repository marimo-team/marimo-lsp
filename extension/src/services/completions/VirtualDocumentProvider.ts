import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { Data, Effect, HashMap, Option, Stream, SubscriptionRef } from "effect";
import type * as vscode from "vscode";
import { getNotebookUri, type NotebookUri } from "../../types.ts";
import { getTopologicalCellIds } from "../../utils/getTopologicalCellIds.ts";
import {
  getNotebookCellId,
  isMarimoNotebookDocument,
  type NotebookCellId,
} from "../../utils/notebook.ts";
import { VsCode } from "../VsCode.ts";
import { VariablesService } from "../variables/VariablesService.ts";

/**
 * Information about a cell's position within the virtual document
 */
interface CellOffsetInfo {
  /** Unique ID of the cell */
  cellId: string;
  /** Index of the cell in the notebook */
  cellIndex: number;
  /** Line index in virtual doc where this cell starts */
  startLine: number;
  /** Line index in virtual doc where this cell ends (exclusive) */
  endLine: number;
  /** Number of lines in the cell */
  lineCount: number;
}

/**
 * Information about a virtual document
 */
interface VirtualDocInfo {
  /** URI of the temp file */
  uri: vscode.Uri;
  /** Full text content of the virtual document */
  content: string;
  /** Ordered list of cell offset info */
  cellOffsets: ReadonlyArray<CellOffsetInfo>;
}

class CellNotFoundError extends Data.TaggedError("CellNotFoundError")<{
  readonly cellId?: NotebookCellId;
}> {}

/**
 * Service that maintains virtual Python documents for marimo notebooks.
 *
 * For each open marimo notebook, creates a virtual document containing
 * all cells in topological order. This allows Pylance to provide accurate
 * completions across cells.
 */
export class VirtualDocumentProvider extends Effect.Service<VirtualDocumentProvider>()(
  "VirtualDocumentProvider",
  {
    dependencies: [VariablesService.Default],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const variablesService = yield* VariablesService;

      // State: Map of notebook URI -> virtual document info
      const virtualDocsRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookUri, VirtualDocInfo>(),
      );

      // Track which notebooks are dirty and need updating
      const tmpDir = NodeOs.tmpdir();
      const dirtyNotebooks = new Set<NotebookUri>();

      /**
       * Create a new virtual document for a notebook
       */
      const createVirtualDocument = Effect.fnUntraced(function* (
        notebook: vscode.NotebookDocument,
      ) {
        // Get cells in topological order
        const cells = yield* getCellsInTopologicalOrder(
          notebook,
          variablesService,
        );

        const { content, cellOffsets } = buildVirtualDocumentContent(cells);

        // Create temp file with hash of notebook URI for consistency
        const notebookUri = getNotebookUri(notebook);
        const hash = Buffer.from(notebookUri)
          .toString("base64")
          .replace(/[/+=]/g, "")
          .slice(0, 16);

        const tmpPath = NodePath.join(tmpDir, `.marimo-virtual-${hash}.py`);
        const uri = yield* code.utils.parseUri(`file://${tmpPath}`);

        // Write content to temp file
        yield* code.workspace.fs.writeFile(
          uri,
          new TextEncoder().encode(content),
        );

        // Open document to trigger language server analysis
        yield* code.workspace.openTextDocument(uri);

        return { uri, content, cellOffsets };
      });

      /**
       * Update virtual document when notebook changes
       */
      const updateVirtualDocument = Effect.fnUntraced(function* (
        notebook: vscode.NotebookDocument,
      ) {
        const notebookUri = getNotebookUri(notebook);
        const currentDocs = yield* SubscriptionRef.get(virtualDocsRef);
        const existingDoc = HashMap.get(currentDocs, notebookUri);

        // If no virtual doc exists yet, create one
        if (Option.isNone(existingDoc)) {
          const virtualDoc = yield* createVirtualDocument(notebook);
          yield* SubscriptionRef.update(virtualDocsRef, (docs) =>
            HashMap.set(docs, notebookUri, virtualDoc),
          );
          return;
        }

        // Update existing virtual document with topological order
        const cells = yield* getCellsInTopologicalOrder(
          notebook,
          variablesService,
        );

        const { content, cellOffsets } = buildVirtualDocumentContent(cells);

        // Update the SAME temp file
        yield* code.workspace.fs.writeFile(
          existingDoc.value.uri,
          new TextEncoder().encode(content),
        );

        // Update the stored info
        yield* SubscriptionRef.update(virtualDocsRef, (docs) =>
          HashMap.set(docs, notebookUri, {
            uri: existingDoc.value.uri, // Keep same URI
            content,
            cellOffsets,
          }),
        );
      });

      // Watch for notebook changes and mark as dirty
      yield* Effect.forkScoped(
        code.workspace.notebookDocumentChanges().pipe(
          Stream.filter((event) => isMarimoNotebookDocument(event.notebook)),
          Stream.tap((event) => {
            const notebookUri = getNotebookUri(event.notebook);
            dirtyNotebooks.add(notebookUri);
            return Effect.void;
          }),
          Stream.runDrain,
        ),
      );

      /**
       * Get or create a virtual document for a notebook
       */
      const getVirtualDocument = Effect.fnUntraced(function* (
        notebook: vscode.NotebookDocument,
      ) {
        const notebookUri = getNotebookUri(notebook);

        // If dirty, update before returning
        if (dirtyNotebooks.has(notebookUri)) {
          yield* updateVirtualDocument(notebook);
          dirtyNotebooks.delete(notebookUri);
          yield* Effect.sleep(1000); // allow pylance to pick up changes
        }

        const currentDocs = yield* SubscriptionRef.get(virtualDocsRef);

        const existingDoc = HashMap.get(currentDocs, notebookUri);
        if (Option.isSome(existingDoc)) {
          return existingDoc.value;
        }

        // Create initial virtual document if it doesn't exist
        const virtualDoc = yield* createVirtualDocument(notebook);

        yield* SubscriptionRef.update(virtualDocsRef, (docs) =>
          HashMap.set(docs, notebookUri, virtualDoc),
        );

        return virtualDoc;
      });

      // Clean up virtual documents when notebooks close
      // TODO: Implement notebook close detection
      return {
        /** Get or create virtual document for a notebook */
        getVirtualDocument,
        /**
         * Get position mapper for a specific cell in a notebook
         */
        getMapperForCell: Effect.fnUntraced(function* (
          cell: vscode.NotebookCell,
        ) {
          const notebook = cell.notebook;
          const virtualDoc = yield* getVirtualDocument(notebook);

          const cellId = getNotebookCellId(cell);
          const cellOffset = virtualDoc.cellOffsets.find(
            (offset) => offset.cellId === cellId,
          );

          if (!cellOffset) {
            return yield* new CellNotFoundError({ cellId });
          }

          return {
            /** Map position from cell to virtual document */
            toVirtual: (cellPosition: vscode.Position) => {
              const virtualLine = cellOffset.startLine + cellPosition.line;
              return new code.Position(virtualLine, cellPosition.character);
            },
            /** Map position from virtual document back to cell */
            fromVirtual: (virtualPosition: vscode.Position) => {
              const cellLine = virtualPosition.line - cellOffset.startLine;
              return new code.Position(cellLine, virtualPosition.character);
            },
          };
        }),
      };
    }),
  },
) {}

/**
 * Get cells in topological order using VariablesService
 */
const getCellsInTopologicalOrder = Effect.fnUntraced(function* (
  notebook: vscode.NotebookDocument,
  variablesService: VariablesService,
) {
  const notebookUri = getNotebookUri(notebook);
  const inOrderCells = notebook.getCells();

  const variables = yield* variablesService.getVariables(notebookUri);

  // If we don't have variables info yet, use notebook order as fallback
  if (Option.isNone(variables)) {
    return inOrderCells;
  }

  const sortedCellIds = getTopologicalCellIds(
    inOrderCells.map((cell) => getNotebookCellId(cell)),
    variables.value,
  );

  // Map cell IDs back to cells
  const cellMap = new Map<NotebookCellId, vscode.NotebookCell>();
  for (const cell of inOrderCells) {
    const cellId = getNotebookCellId(cell);
    cellMap.set(cellId, cell);
  }

  // biome-ignore lint/style/noNonNullAssertion: We checked existence above
  return sortedCellIds.map((id) => cellMap.get(id)!);
});

/**
 * Build virtual document content from cells and track offsets
 * @param cells - Array of notebook cells
 * @returns Virtual document content as a single string
 */
function buildVirtualDocumentContent(cells: Array<vscode.NotebookCell>): {
  content: string;
  cellOffsets: ReadonlyArray<CellOffsetInfo>;
} {
  let currentLine = 0;
  const cellOffsets: Array<CellOffsetInfo> = [];
  const contentParts: Array<string> = [];

  for (const cell of cells) {
    const cellContent = cell.document.getText();
    const lines = cellContent.split("\n");
    const lineCount = lines.length;

    cellOffsets.push({
      cellId: cell.document.uri.toString(),
      cellIndex: cell.index,
      startLine: currentLine,
      endLine: currentLine + lineCount,
      lineCount,
    });

    contentParts.push(cellContent);
    currentLine += lineCount;
  }

  return {
    content: contentParts.join("\n"),
    cellOffsets,
  };
}
