/**
 * Creates a {@link NotebookLspClient} and wires it to VS Code notebook
 * events, diagnostics, and language feature providers.
 *
 * This is the single entry point for managed servers (Ruff, ty). Callers
 * pass configuration and get back an opaque handle with `serverInfo` and
 * `serverInfo`. Everything else — cell ordering, event
 * listeners, provider registration — is managed internally.
 */

import { Effect, Option, Runtime, Stream } from "effect";
import type * as vscode from "vscode";
import type * as lsp from "vscode-languageserver-protocol";

import { NOTEBOOK_TYPE } from "../constants.ts";
import { MarimoNotebookDocument } from "../schemas.ts";
import { registerLspProviders } from "../services/completions/registerLspProviders.ts";
import { VsCode } from "../services/VsCode.ts";
import { acquireDisposable } from "./acquireDisposable.ts";
import {
  makeNotebookLspClient,
  type NotebookLspClientConfig,
} from "./makeMarimoLspClient.ts";

/**
 * Create a managed LSP client connected to VS Code events.
 *
 * This is a scoped effect — the server process, event listeners,
 * diagnostic collection, and feature providers are all tied to the
 * scope and cleaned up automatically.
 */
export const connectMarimoNotebookLspClient = Effect.fn(
  "connectMarimoNotebookLspClient",
)(function* (config: NotebookLspClientConfig) {
  const code = yield* VsCode;
  const runPromise = Runtime.runPromise(yield* Effect.runtime());

  // -- Create the LSP client -----------------------------------------------

  const client = yield* makeNotebookLspClient(config);

  // -- Diagnostics ---------------------------------------------------------

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

  // -- VS Code events → client lifecycle -----------------------------------

  yield* Effect.forkScoped(
    code.workspace.notebookDocumentOpened().pipe(
      Stream.filter((nb) => nb.notebookType === NOTEBOOK_TYPE),
      Stream.runForEach((nb) => {
        const doc = MarimoNotebookDocument.tryFrom(nb);
        return Option.isSome(doc)
          ? client.openNotebookDocument(doc.value)
          : Effect.void;
      }),
    ),
  );

  yield* Effect.forkScoped(
    code.workspace.notebookDocumentChanges().pipe(
      Stream.filter((evt) => evt.notebook.notebookType === NOTEBOOK_TYPE),
      Stream.runForEach((evt) => client.notebookDocumentChange(evt)),
    ),
  );

  yield* Effect.forkScoped(
    code.workspace.textDocumentChanges().pipe(
      Stream.filter(
        (evt) => evt.document.uri.scheme === "vscode-notebook-cell",
      ),
      Stream.runForEach((evt) => client.textDocumentChange(evt)),
    ),
  );

  yield* Effect.forkScoped(
    code.workspace.notebookDocumentClosed().pipe(
      Stream.filter((nb) => nb.notebookType === NOTEBOOK_TYPE),
      Stream.runForEach((nb) => {
        const doc = MarimoNotebookDocument.tryFrom(nb);
        return Option.isSome(doc)
          ? client.closeNotebookDocument(doc.value)
          : Effect.void;
      }),
    ),
  );

  // -- Register language feature providers ---------------------------------

  yield* registerLspProviders(client);

  // -- Open any already-open notebooks -------------------------------------

  const existingNotebooks = yield* code.workspace.getNotebookDocuments();
  for (const nb of existingNotebooks) {
    if (nb.notebookType === NOTEBOOK_TYPE) {
      const doc = MarimoNotebookDocument.tryFrom(nb);
      if (Option.isSome(doc)) {
        yield* client.openNotebookDocument(doc.value);
      }
    }
  }

  // -- File watchers (from server's dynamic registrations) -----------------

  yield* Effect.forkScoped(
    Effect.gen(function* () {
      // Give the server time to send registerCapability
      yield* Effect.sleep("500 millis");

      const regsOption = yield* client.registrations.get(
        "workspace/didChangeWatchedFiles",
      );

      if (Option.isNone(regsOption) || regsOption.value.length === 0) {
        return;
      }

      for (const reg of regsOption.value) {
        const opts = reg.registerOptions as
          | { watchers?: Array<{ globPattern: string }> }
          | undefined;

        if (!opts?.watchers) {
          continue;
        }

        for (const watcher of opts.watchers) {
          const pattern =
            typeof watcher.globPattern === "string"
              ? watcher.globPattern
              : undefined;
          if (!pattern) continue;

          const fsWatcher = yield* acquireDisposable(() =>
            code.workspace.createFileSystemWatcher(pattern),
          );

          const sendChange = (uri: { toString(): string }, type: number) =>
            client
              .sendNotification("workspace/didChangeWatchedFiles", {
                changes: [{ uri: uri.toString(), type }],
              })
              .pipe(Effect.catchAll(() => Effect.void));

          fsWatcher.onDidCreate((uri) => {
            void runPromise(sendChange(uri, 1));
          });
          fsWatcher.onDidChange((uri) => {
            void runPromise(sendChange(uri, 2));
          });
          fsWatcher.onDidDelete((uri) => {
            void runPromise(sendChange(uri, 3));
          });
        }
      }
    }),
  );

  // -- Return opaque handle ------------------------------------------------

  return {
    serverInfo: client.serverInfo,
  };
});

export type MarimoNotebookLspClient = Effect.Effect.Success<
  ReturnType<typeof connectMarimoNotebookLspClient>
>;

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
