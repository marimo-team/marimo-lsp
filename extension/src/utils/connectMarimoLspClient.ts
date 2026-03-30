/**
 * Creates a {@link NotebookLspClient} and wires it to VS Code notebook
 * events, diagnostics, and language feature providers.
 *
 * This is the single entry point for managed servers (Ruff, ty). Callers
 * pass configuration and get back an opaque handle with `serverInfo` and
 * `serverInfo`. Everything else — cell ordering, event
 * listeners, provider registration — is managed internally.
 */

import { Effect, Option, Stream } from "effect";
import type * as vscode from "vscode";
import type * as lsp from "vscode-languageserver-protocol";

import { NOTEBOOK_TYPE } from "../constants.ts";
import { MarimoNotebookDocument } from "../schemas.ts";
import { registerLspProviders } from "../services/completions/registerLspProviders.ts";
import { toVsCodeDiagnosticSeverity } from "../services/lsp/providers/converters.ts";
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
      // Wait for the server to dynamically register file watchers.
      // Times out after 10s — if the server doesn't register, we skip.
      const regs = yield* client.registrations
        .await("workspace/didChangeWatchedFiles")
        .pipe(Effect.timeout("10 seconds"), Effect.option);

      if (Option.isNone(regs)) {
        yield* Effect.logWarning(
          "Server did not register workspace/didChangeWatchedFiles within timeout",
        );
        return;
      }

      for (const reg of regs.value) {
        const watchers = getFileWatchers(reg.registerOptions);
        if (!watchers) {
          continue;
        }

        for (const watcher of watchers) {
          if (typeof watcher.globPattern !== "string") continue;

          yield* Effect.forkScoped(
            code.workspace.createFileSystemWatcher(watcher.globPattern).pipe(
              Stream.runForEach(({ uri, type }) =>
                client
                  .sendNotification("workspace/didChangeWatchedFiles", {
                    changes: [{ uri: uri.toString(), type }],
                  })
                  .pipe(Effect.catchAll(() => Effect.void)),
              ),
            ),
          );
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
 * Extract file watchers from a dynamic registration's options.
 */
function getFileWatchers(
  options: unknown,
): Array<{ globPattern: unknown }> | undefined {
  if (
    typeof options === "object" &&
    options !== null &&
    "watchers" in options &&
    Array.isArray(options.watchers)
  ) {
    return options.watchers;
  }
  return undefined;
}

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
  const severity =
    d.severity != null
      ? toVsCodeDiagnosticSeverity(code, d.severity)
      : code.DiagnosticSeverity.Error;
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
