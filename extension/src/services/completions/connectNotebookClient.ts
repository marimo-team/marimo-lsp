/**
 * Wires a {@link NotebookLspClient} to VS Code notebook events and
 * diagnostic display.
 *
 * This is the bridge between the pure LSP client and VS Code's APIs.
 * It listens for notebook open/change/close events, feeds topologically
 * ordered cells into the client, forwards text edits, and pipes the
 * client's `diagnostics` stream into a VS Code `DiagnosticCollection`.
 */

import { Effect, Option, Stream } from "effect";
import type * as vscode from "vscode";
import type * as lsp from "vscode-languageserver-protocol";

import { NOTEBOOK_TYPE } from "../../constants.ts";
import { MarimoNotebookDocument } from "../../schemas.ts";
import { acquireDisposable } from "../../utils/acquireDisposable.ts";
import { getTopologicalCells } from "../../utils/getTopologicalCells.ts";
import { VariablesService } from "../variables/VariablesService.ts";
import { VsCode } from "../VsCode.ts";
import type { NotebookLspClient, SyncedCell } from "./NotebookLspClient.ts";

/**
 * Convert VS Code `NotebookCell[]` to the flat `SyncedCell` format.
 * Normalizes `mo-python` → `python` for the server.
 */
function toSyncedCells(cells: readonly vscode.NotebookCell[]): SyncedCell[] {
  return cells.map((cell) => ({
    uri: cell.document.uri.toString(),
    languageId:
      cell.document.languageId === "mo-python"
        ? "python"
        : cell.document.languageId,
    version: cell.document.version,
    text: cell.document.getText(),
    kind: cell.kind,
  }));
}

/**
 * Get topologically ordered cells for a notebook, converted to SyncedCell.
 */
function getOrderedCells(
  raw: vscode.NotebookDocument,
): Effect.Effect<SyncedCell[], never, VariablesService> {
  const doc = MarimoNotebookDocument.tryFrom(raw);
  if (Option.isNone(doc)) {
    return Effect.succeed([]);
  }
  return getTopologicalCells(doc.value).pipe(Effect.map(toSyncedCells));
}

/**
 * Wire a NotebookLspClient to VS Code events and diagnostics.
 *
 * This is a scoped effect — all event listeners and the diagnostic
 * collection are tied to the scope and cleaned up automatically.
 */
export const connectNotebookClient = Effect.fn("connectNotebookClient")(
  function* (client: NotebookLspClient) {
    const code = yield* VsCode;
    const variables = yield* VariablesService;

    // -- Diagnostics --------------------------------------------------------

    const diagnosticCollection = yield* acquireDisposable(() =>
      code.languages.createDiagnosticCollection(client.serverInfo.name),
    );

    yield* Effect.forkScoped(
      client.diagnostics.pipe(
        Stream.runForEach((params) =>
          Effect.sync(() => {
            diagnosticCollection.set(
              code.Uri.parse(params.uri),
              params.diagnostics.map((d) =>
                toLspDiagnostic(code, client.serverInfo.name, d),
              ),
            );
          }),
        ),
      ),
    );

    // -- Notebook open ------------------------------------------------------

    const openNotebook = Effect.fn(function* (raw: vscode.NotebookDocument) {
      const cells = yield* getOrderedCells(raw);
      if (cells.length === 0) return;
      yield* client.openNotebook(raw.uri.toString(), raw.version, cells);
    });

    const reorderNotebook = Effect.fn(function* (raw: vscode.NotebookDocument) {
      const cells = yield* getOrderedCells(raw);
      yield* client.reorderCells(raw.uri.toString(), raw.version, cells);
    });

    // -- Listen: notebook open events ---------------------------------------

    yield* Effect.forkScoped(
      code.workspace.notebookDocumentOpened().pipe(
        Stream.filter((nb) => nb.notebookType === NOTEBOOK_TYPE),
        Stream.runForEach(openNotebook),
      ),
    );

    // -- Listen: notebook structural changes (cell add/remove) --------------

    yield* Effect.forkScoped(
      code.workspace.notebookDocumentChanges().pipe(
        Stream.filter((evt) => evt.notebook.notebookType === NOTEBOOK_TYPE),
        Stream.filter((evt) => evt.contentChanges.length > 0),
        Stream.runForEach((evt) => reorderNotebook(evt.notebook)),
      ),
    );

    // -- Listen: text content changes in notebook cells ---------------------

    yield* Effect.forkScoped(
      code.workspace.textDocumentChanges().pipe(
        Stream.filter(
          (evt) => evt.document.uri.scheme === "vscode-notebook-cell",
        ),
        Stream.filter((evt) => evt.contentChanges.length > 0),
        Stream.runForEach(
          Effect.fnUntraced(function* (evt) {
            // Find the parent notebook
            const notebooks = yield* code.workspace.getNotebookDocuments();
            const nb = notebooks.find((n) =>
              n
                .getCells()
                .some(
                  (c) =>
                    c.document.uri.toString() === evt.document.uri.toString(),
                ),
            );
            if (!nb || nb.notebookType !== NOTEBOOK_TYPE) return;

            yield* client.changeCellText(
              nb.uri.toString(),
              nb.version,
              evt.document.uri.toString(),
              evt.document.version,
              evt.contentChanges.map((c) => ({
                range: {
                  start: {
                    line: c.range.start.line,
                    character: c.range.start.character,
                  },
                  end: {
                    line: c.range.end.line,
                    character: c.range.end.character,
                  },
                },
                rangeLength: c.rangeLength,
                text: c.text,
              })),
            );
          }),
        ),
      ),
    );

    // -- Listen: notebook close events --------------------------------------

    yield* Effect.forkScoped(
      code.workspace.notebookDocumentClosed().pipe(
        Stream.filter((nb) => nb.notebookType === NOTEBOOK_TYPE),
        Stream.runForEach((nb) => client.closeNotebook(nb.uri.toString())),
      ),
    );

    // -- Listen: variable declaration changes → reorder ---------------------

    yield* Effect.forkScoped(
      variables.notebookUpdates().pipe(
        Stream.filter((evt) => evt.kind === "declaration"),
        Stream.mapEffect(
          Effect.fnUntraced(function* (evt) {
            const notebooks = yield* code.workspace.getNotebookDocuments();
            const raw = notebooks.find((nb) => {
              const doc = MarimoNotebookDocument.tryFrom(nb);
              return Option.isSome(doc) && doc.value.id === evt.notebookId;
            });
            if (raw) {
              yield* reorderNotebook(raw);
            }
          }),
        ),
        Stream.runDrain,
      ),
    );

    // -- Open any already-open notebooks ------------------------------------

    const existingNotebooks = yield* code.workspace.getNotebookDocuments();
    for (const nb of existingNotebooks) {
      if (nb.notebookType === NOTEBOOK_TYPE) {
        yield* openNotebook(nb);
      }
    }
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an LSP diagnostic to a VS Code Diagnostic.
 */
function toLspDiagnostic(
  code: VsCode,
  source: string,
  d: lsp.Diagnostic,
): vscode.Diagnostic {
  const range = new code.Range(
    new code.Position(d.range.start.line, d.range.start.character),
    new code.Position(d.range.end.line, d.range.end.character),
  );
  // LSP severity is 1-based (1=Error, 2=Warning, 3=Info, 4=Hint)
  // VS Code DiagnosticSeverity is 0-based (0=Error, 1=Warning, 2=Info, 3=Hint)
  const severity = d.severity != null ? d.severity - 1 : 0;
  const diag = new code.Diagnostic(range, d.message, severity);
  diag.source = source;
  if (d.code != null) {
    diag.code =
      typeof d.code === "string" || typeof d.code === "number"
        ? d.code
        : undefined;
  }
  if (d.tags) {
    diag.tags = d.tags.map(
      (t) =>
        t === 1 // DiagnosticTag.Unnecessary
          ? 1
          : 2, // DiagnosticTag.Deprecated
    );
  }
  return diag;
}
