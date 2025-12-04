import { Data, Effect, HashMap, Option, Stream, SubscriptionRef } from "effect";
import type * as vscode from "vscode";
import {
  type MarimoNotebookCell,
  MarimoNotebookDocument,
  type NotebookCellId,
  type NotebookId,
} from "../../schemas.ts";
import { getTopologicalCellIds } from "../../utils/getTopologicalCellIds.ts";
import { VsCode } from "../VsCode.ts";
import { VariablesService } from "../variables/VariablesService.ts";
import { PythonLanguageServer } from "./PythonLanguageServer.ts";

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
  /** URI string for the virtual document */
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
 * all cells in topological order. This allows the Python language server
 * to provide accurate completions across cells.
 */
export class VirtualDocumentProvider extends Effect.Service<VirtualDocumentProvider>()(
  "VirtualDocumentProvider",
  {
    dependencies: [VariablesService.Default],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const variablesService = yield* VariablesService;
      const pythonLs = yield* PythonLanguageServer;

      // State: Map of notebook URI -> virtual document info
      const virtualDocsRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, VirtualDocInfo>(),
      );

      /**
       * Create a new virtual document for a notebook
       */
      const createVirtualDocument = Effect.fnUntraced(function* (
        notebook: MarimoNotebookDocument,
      ) {
        // Get cells in topological order
        const cells = yield* getCellsInTopologicalOrder(
          notebook,
          variablesService,
        );

        const { content, cellOffsets } = buildVirtualDocumentContent(cells);

        const hash = Buffer.from(notebook.id)
          .toString("base64")
          .replace(/[/+=]/g, "")
          .slice(0, 16);

        const basename =
          notebook.uri.toString().split("/").pop()?.split(".")[0] ?? "notebook";

        const virtualUri = code.Uri.file(`/marimo/${basename}_${hash}.py`);

        // Open virtual document in Python language server
        yield* pythonLs.openDocument(virtualUri, content);

        return { uri: virtualUri, content, cellOffsets };
      });

      /**
       * Update virtual document when notebook changes
       */
      const updateVirtualDocument = Effect.fnUntraced(function* (
        notebook: MarimoNotebookDocument,
      ) {
        const currentDocs = yield* SubscriptionRef.get(virtualDocsRef);
        const existingDoc = HashMap.get(currentDocs, notebook.id);

        // If no virtual doc exists yet, create one
        if (Option.isNone(existingDoc)) {
          const virtualDoc = yield* createVirtualDocument(notebook);
          yield* SubscriptionRef.update(virtualDocsRef, (docs) =>
            HashMap.set(docs, notebook.id, virtualDoc),
          );
          return;
        }

        // Update existing virtual document with topological order
        const cells = yield* getCellsInTopologicalOrder(
          notebook,
          variablesService,
        );

        const { content, cellOffsets } = buildVirtualDocumentContent(cells);

        // Update virtual document in Python language server
        yield* pythonLs.updateDocument(existingDoc.value.uri, content);

        // Update the stored info
        yield* SubscriptionRef.update(virtualDocsRef, (docs) =>
          HashMap.set(docs, notebook.id, {
            uri: existingDoc.value.uri, // Keep same URI
            content,
            cellOffsets,
          }),
        );
      });

      // Watch for notebook changes and mark as dirty
      yield* Effect.forkScoped(
        code.workspace.notebookDocumentChanges().pipe(
          Stream.filterMap((event) =>
            MarimoNotebookDocument.tryFrom(event.notebook),
          ),
          Stream.runForEach((notebook) => {
            return updateVirtualDocument(notebook);
          }),
        ),
      );

      /**
       * Get or create a virtual document for a notebook
       */
      const getVirtualDocument = Effect.fnUntraced(function* (
        notebook: MarimoNotebookDocument,
      ) {
        const currentDocs = yield* SubscriptionRef.get(virtualDocsRef);

        const existingDoc = HashMap.get(currentDocs, notebook.id);
        if (Option.isSome(existingDoc)) {
          return existingDoc.value;
        }

        // Create initial virtual document if it doesn't exist
        const virtualDoc = yield* createVirtualDocument(notebook);

        yield* SubscriptionRef.update(virtualDocsRef, (docs) =>
          HashMap.set(docs, notebook.id, virtualDoc),
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
          cell: MarimoNotebookCell,
        ) {
          const virtualDoc = yield* getVirtualDocument(cell.notebook);
          const cellOffset = virtualDoc.cellOffsets.find(
            (offset) => offset.cellId === cell.id,
          );

          if (!cellOffset) {
            return yield* new CellNotFoundError({ cellId: cell.id });
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
        /**
         * Find the cell that contains a given line in the virtual document
         */
        findCellForVirtualLine: Effect.fnUntraced(function* (
          notebook: MarimoNotebookDocument,
          virtualLine: number,
        ) {
          const virtualDoc = yield* getVirtualDocument(notebook);

          // Find the cell offset that contains this virtual line
          const cellOffset = virtualDoc.cellOffsets.find(
            (offset) =>
              virtualLine >= offset.startLine && virtualLine < offset.endLine,
          );

          if (!cellOffset) {
            return Option.none<MarimoNotebookCell>();
          }

          // Find the actual cell by index
          const cell = notebook.getCells()[cellOffset.cellIndex];
          return Option.fromNullable(cell);
        }),
      };
    }),
  },
) {}

/**
 * Get cells in topological order using VariablesService
 */
const getCellsInTopologicalOrder = Effect.fnUntraced(function* (
  notebook: MarimoNotebookDocument,
  variablesService: VariablesService,
) {
  const inOrderCells: MarimoNotebookCell[] = notebook.getCells();

  const variables = yield* variablesService.getVariables(notebook.id);

  // If we don't have variables info yet, use notebook order as fallback
  if (Option.isNone(variables)) {
    return inOrderCells;
  }

  const sortedCellIds = getTopologicalCellIds(
    inOrderCells.flatMap((cell) =>
      Option.match(cell.maybeId, {
        onNone: () => [],
        onSome: (id) => [id],
      }),
    ),
    variables.value,
  );

  // Map cell IDs back to cells
  const cellMap = new Map<NotebookCellId, MarimoNotebookCell>();
  for (const cell of inOrderCells) {
    if (Option.isNone(cell.maybeId)) {
      continue;
    }
    cellMap.set(cell.id, cell);
  }

  // biome-ignore lint/style/noNonNullAssertion: We checked existence above
  return sortedCellIds.map((id) => cellMap.get(id)!);
});

/**
 * Build virtual document content from cells and track offsets
 * @param cells - Array of notebook cells
 * @returns Virtual document content as a single string
 */
function buildVirtualDocumentContent(
  cells: Array<{
    readonly id: NotebookCellId;
    readonly index: number;
    readonly document: vscode.TextDocument;
  }>,
): {
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
      cellId: cell.id,
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
