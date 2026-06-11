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
import * as lsp from "vscode-languageserver-protocol";

import { NOTEBOOK_TYPE } from "../constants.ts";
import { acquireDisposable } from "../lib/acquireDisposable.ts";
import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";
import {
  makeNotebookLspClient,
  type NotebookLspClientConfig,
} from "./client.ts";
import { toVsCodeDiagnosticSeverity } from "./converters.ts";
import { registerLspProviders } from "./registerLspProviders.ts";

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

  // -- Resolve workspace folders -------------------------------------------

  const folders = yield* code.workspace.getWorkspaceFolders();
  const workspaceFolders = Option.getOrElse(folders, () => []).map((f) => ({
    uri: f.uri.toString(),
    name: f.name,
  }));

  // -- Create the LSP client -----------------------------------------------

  const client = yield* makeNotebookLspClient({ ...config, workspaceFolders });

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
          const globPattern = toVsCodeGlobPattern(code, watcher.globPattern);
          if (Option.isNone(globPattern)) continue;

          // `kind` is a WatchKind bitmask; absent means watch all three
          // (the LSP default).
          const kind =
            typeof watcher.kind === "number"
              ? watcher.kind
              : lsp.WatchKind.Create |
                lsp.WatchKind.Change |
                lsp.WatchKind.Delete;

          yield* Effect.forkScoped(
            code.workspace.createFileSystemWatcher(globPattern.value).pipe(
              // Drop events the server didn't ask to watch.
              Stream.filter(
                ({ type }) => (kind & WATCH_KIND_FOR_CHANGE[type]) !== 0,
              ),
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
): Array<{ globPattern: unknown; kind?: unknown }> | undefined {
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
 * The `WatchKind` bit that enables each `FileChangeType`, so a change
 * event can be tested against a watcher's `kind` bitmask. Typing it as a
 * `Record` over `FileChangeType` forces every change type to be mapped.
 */
const WATCH_KIND_FOR_CHANGE: Record<lsp.FileChangeType, lsp.WatchKind> = {
  [lsp.FileChangeType.Created]: lsp.WatchKind.Create,
  [lsp.FileChangeType.Changed]: lsp.WatchKind.Change,
  [lsp.FileChangeType.Deleted]: lsp.WatchKind.Delete,
};

/**
 * The wire shape of an LSP `RelativePattern` with a string `baseUri` —
 * the form ty emits. (The spec also allows a workspace-folder `baseUri`,
 * which ty never sends and we can't resolve here.)
 */
function isRelativePattern(
  value: unknown,
): value is { baseUri: string; pattern: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "baseUri" in value &&
    "pattern" in value &&
    typeof value.baseUri === "string" &&
    typeof value.pattern === "string"
  );
}

/**
 * Convert an LSP `GlobPattern` to a VS Code glob pattern.
 *
 * The server may send either a plain string glob or a `RelativePattern`
 * object (`{ baseUri, pattern }`) when the client advertises
 * `relativePatternSupport`. ty uses the latter to watch module search
 * paths *outside* the workspace root, so we must handle both — mirroring
 * vscode-languageclient's `protocolConverter.asGlobPattern`.
 *
 * Returns `None` for shapes we can't interpret — a workspace-folder
 * baseUri (which ty never emits) or a `baseUri` that `Uri.parse` rejects.
 * A malformed pattern is skipped rather than aborting watcher setup.
 *
 * @internal exported for testing.
 */
export function toVsCodeGlobPattern(
  code: VsCode,
  globPattern: unknown,
): Option.Option<vscode.GlobPattern> {
  if (typeof globPattern === "string") {
    return Option.some(globPattern);
  }
  if (isRelativePattern(globPattern)) {
    // Uri.parse throws on a malformed baseUri; treat that as a shape we
    // can't interpret instead of letting it abort watcher registration.
    const parseRelativePattern = Option.liftThrowable(
      (uri: string) =>
        new code.RelativePattern(code.Uri.parse(uri), globPattern.pattern),
    );
    return parseRelativePattern(globPattern.baseUri);
  }
  return Option.none();
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
