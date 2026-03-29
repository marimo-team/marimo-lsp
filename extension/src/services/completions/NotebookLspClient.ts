/**
 * A minimal, Effect-based LSP client tailored for notebook document sync.
 *
 * Unlike vscode-languageclient's `LanguageClient`, this client owns the
 * full cell-ordering lifecycle. There is no internal `syncInfo` that can
 * diverge from what the server actually received — we track exactly what
 * we sent and update it atomically.
 *
 * The client exposes:
 * - Notebook sync methods (openNotebook, reorderCells, changeCellText, closeNotebook)
 * - Typed request methods (requestHover, requestCompletion, etc.)
 * - A typed `diagnostics` stream for server-pushed diagnostics
 *
 * VS Code event wiring and provider registration are handled separately
 * by the VsCode service's `connectNotebookClient` method.
 *
 * Transport: stdio (stdin/stdout) via `vscode-jsonrpc`.
 * Protocol types: `vscode-languageserver-protocol`.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeProcess from "node:process";

import { Effect, HashMap, Option, PubSub, Ref, Runtime, Stream } from "effect";
import * as rpc from "vscode-jsonrpc/node";
import * as lsp from "vscode-languageserver-protocol";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NotebookUri = string;

/** The cells we last told the server about, in server order. */
interface SyncedCell {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  readonly text: string;
  readonly kind: number;
}

export interface NotebookLspClientConfig {
  /** Human-readable name, e.g. "ruff" or "ty". */
  name: string;
  /** Absolute path to the server binary. */
  command: string;
  /** Arguments (typically `["server"]`). */
  args: string[];
  /** Extra environment variables for the server process. */
  env?: Record<string, string | undefined>;
  /** Sent as `initializationOptions` in the initialize request. */
  initializationOptions?: unknown;
  /** Workspace folders to send during initialization. */
  workspaceFolders?: ReadonlyArray<{
    uri: string;
    name: string;
  }>;
}

export interface ServerInfo {
  name: string;
  version: string;
  capabilities: lsp.ServerCapabilities;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Create a scoped `NotebookLspClient`.
 *
 * The server process and JSON-RPC connection are tied to the Effect scope —
 * when the scope closes, the server is shut down and the process killed.
 */
export const makeNotebookLspClient = Effect.fn("makeNotebookLspClient")(
  function* (config: NotebookLspClientConfig) {
    const runFork = Runtime.runFork(yield* Effect.runtime());
    // -- 1. Spawn process ---------------------------------------------------

    const proc = NodeChildProcess.spawn(config.command, config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...NodeProcess.env, ...config.env },
    });

    yield* Effect.addFinalizer(() => Effect.sync(() => proc.kill()));

    const stdout = proc.stdout;
    const stdin = proc.stdin;
    if (!stdout || !stdin) {
      return yield* Effect.die(
        new Error("Failed to get stdio streams from server process"),
      );
    }

    // -- 2. Create JSON-RPC connection --------------------------------------

    const conn = rpc.createMessageConnection(
      new rpc.StreamMessageReader(stdout),
      new rpc.StreamMessageWriter(stdin),
    );
    conn.listen();

    yield* Effect.addFinalizer(() => Effect.sync(() => conn.dispose()));

    // -- 3. Initialize handshake --------------------------------------------

    const initResult = yield* Effect.promise(() =>
      conn.sendRequest<lsp.InitializeResult>("initialize", {
        processId: NodeProcess.pid,
        capabilities: {
          general: {
            positionEncodings: [
              lsp.PositionEncodingKind.UTF32,
              lsp.PositionEncodingKind.UTF16,
            ],
          },
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              didSave: false,
            },
            publishDiagnostics: {
              relatedInformation: true,
              codeDescriptionSupport: true,
              dataSupport: true,
              tagSupport: {
                valueSet: [
                  lsp.DiagnosticTag.Unnecessary,
                  lsp.DiagnosticTag.Deprecated,
                ],
              },
            },
            codeAction: {
              codeActionLiteralSupport: {
                codeActionKind: {
                  valueSet: [
                    lsp.CodeActionKind.QuickFix,
                    lsp.CodeActionKind.SourceFixAll,
                    lsp.CodeActionKind.SourceOrganizeImports,
                    "notebook.source.fixAll",
                    "notebook.source.organizeImports",
                  ],
                },
              },
              resolveSupport: { properties: ["edit"] },
              dataSupport: true,
            },
            completion: {
              completionItem: {
                snippetSupport: false,
                documentationFormat: [
                  lsp.MarkupKind.Markdown,
                  lsp.MarkupKind.PlainText,
                ],
              },
            },
            hover: {
              contentFormat: [
                lsp.MarkupKind.Markdown,
                lsp.MarkupKind.PlainText,
              ],
            },
            signatureHelp: {
              signatureInformation: {
                documentationFormat: [
                  lsp.MarkupKind.Markdown,
                  lsp.MarkupKind.PlainText,
                ],
                parameterInformation: { labelOffsetSupport: true },
              },
            },
            rename: { prepareSupport: true },
            semanticTokens: {
              requests: { full: true, range: true },
              tokenTypes: [
                "namespace",
                "class",
                "parameter",
                "selfParameter",
                "clsParameter",
                "variable",
                "property",
                "function",
                "method",
                "keyword",
                "string",
                "number",
                "decorator",
                "builtinConstant",
                "typeParameter",
              ],
              tokenModifiers: [
                "definition",
                "readonly",
                "async",
                "documentation",
              ],
              formats: [lsp.TokenFormat.Relative],
            },
            inlayHint: { resolveSupport: { properties: [] } },
          },
          notebookDocument: {
            synchronization: {
              dynamicRegistration: false,
              executionSummarySupport: false,
            },
          },
          workspace: { workspaceFolders: true },
        } satisfies lsp.ClientCapabilities,
        rootUri: config.workspaceFolders?.[0]?.uri ?? null,
        workspaceFolders:
          config.workspaceFolders?.map((f) => ({
            uri: f.uri,
            name: f.name,
          })) ?? null,
        initializationOptions: config.initializationOptions ?? {},
      } satisfies lsp.InitializeParams),
    );

    yield* Effect.promise(() => conn.sendNotification("initialized", {}));

    const serverInfo: ServerInfo = {
      name: initResult.serverInfo?.name ?? config.name,
      version: initResult.serverInfo?.version ?? "unknown",
      capabilities: initResult.capabilities,
    };

    yield* Effect.logInfo("Server initialized").pipe(
      Effect.annotateLogs({
        server: serverInfo.name,
        version: serverInfo.version,
      }),
    );

    // -- 4. Shutdown finalizer (graceful before kill) -----------------------

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Effect.promise(() => conn.sendRequest("shutdown")).pipe(
          Effect.timeout("5 seconds"),
          Effect.catchAll(() => Effect.void),
        );
        yield* Effect.promise(() => conn.sendNotification("exit")).pipe(
          Effect.catchAll(() => Effect.void),
        );
      }),
    );

    // -- 5. Cell order tracking ---------------------------------------------

    const cellOrderRef = yield* Ref.make(
      HashMap.empty<NotebookUri, ReadonlyArray<SyncedCell>>(),
    );

    // -- 6. Diagnostics stream ----------------------------------------------

    const diagnosticsPubSub =
      yield* PubSub.unbounded<lsp.PublishDiagnosticsParams>();

    conn.onNotification(
      lsp.PublishDiagnosticsNotification.method,
      (params: lsp.PublishDiagnosticsParams) => {
        runFork(PubSub.publish(diagnosticsPubSub, params));
      },
    );

    // -- 7. LSP cell helpers ------------------------------------------------

    const toLspCell = (c: SyncedCell) => ({
      kind:
        c.kind === 2 ? lsp.NotebookCellKind.Code : lsp.NotebookCellKind.Markup,
      document: c.uri,
    });

    const toLspTextDocument = (c: SyncedCell) => ({
      uri: c.uri,
      languageId: c.languageId,
      version: c.version,
      text: c.text,
    });

    // -- 8. Public API ------------------------------------------------------

    return {
      serverInfo,

      // ---- Notebook sync ------------------------------------------------

      openNotebook: Effect.fn(function* (
        notebookUri: string,
        notebookVersion: number,
        cells: ReadonlyArray<SyncedCell>,
      ) {
        yield* Ref.update(cellOrderRef, HashMap.set(notebookUri, cells));
        yield* Effect.promise(() =>
          conn.sendNotification("notebookDocument/didOpen", {
            notebookDocument: {
              uri: notebookUri,
              notebookType: "marimo-notebook",
              version: notebookVersion,
              cells: cells.map(toLspCell),
            },
            cellTextDocuments: cells.map(toLspTextDocument),
          } satisfies lsp.DidOpenNotebookDocumentParams),
        );
      }),

      reorderCells: Effect.fn(function* (
        notebookUri: string,
        notebookVersion: number,
        newCells: ReadonlyArray<SyncedCell>,
      ) {
        const current = yield* Ref.get(cellOrderRef).pipe(
          Effect.map(HashMap.get(notebookUri)),
        );

        if (Option.isNone(current)) {
          return;
        }

        const oldCells = current.value;
        if (
          oldCells.length === newCells.length &&
          oldCells.every((c, i) => c.uri === newCells[i].uri)
        ) {
          return;
        }

        yield* Ref.update(cellOrderRef, HashMap.set(notebookUri, newCells));
        yield* Effect.promise(() =>
          conn.sendNotification("notebookDocument/didChange", {
            notebookDocument: { uri: notebookUri, version: notebookVersion },
            change: {
              cells: {
                structure: {
                  array: {
                    start: 0,
                    deleteCount: oldCells.length,
                    cells: newCells.map(toLspCell),
                  },
                  didOpen: newCells.map(toLspTextDocument),
                  didClose: [],
                },
              },
            },
          } satisfies lsp.DidChangeNotebookDocumentParams),
        );
      }),

      changeCellText: Effect.fn(function* (
        notebookUri: string,
        notebookVersion: number,
        cellUri: string,
        cellVersion: number,
        changes: lsp.TextDocumentContentChangeEvent[],
      ) {
        yield* Effect.promise(() =>
          conn.sendNotification("notebookDocument/didChange", {
            notebookDocument: { uri: notebookUri, version: notebookVersion },
            change: {
              cells: {
                textContent: [
                  {
                    document: { uri: cellUri, version: cellVersion },
                    changes,
                  },
                ],
              },
            },
          } satisfies lsp.DidChangeNotebookDocumentParams),
        );
      }),

      closeNotebook: Effect.fn(function* (notebookUri: string) {
        const current = HashMap.get(yield* Ref.get(cellOrderRef), notebookUri);
        yield* Ref.update(cellOrderRef, HashMap.remove(notebookUri));

        const cellTextDocuments = current.pipe(
          Option.map((cells) => cells.map((c) => ({ uri: c.uri }))),
          Option.getOrElse(() => []),
        );

        yield* Effect.promise(() =>
          conn.sendNotification("notebookDocument/didClose", {
            notebookDocument: { uri: notebookUri },
            cellTextDocuments: cellTextDocuments,
          } satisfies lsp.DidCloseNotebookDocumentParams),
        );
      }),

      // ---- Typed requests -----------------------------------------------

      requestHover(params: lsp.HoverParams) {
        return Effect.promise(() =>
          conn.sendRequest<lsp.Hover | null>(lsp.HoverRequest.method, params),
        );
      },

      requestCompletion(params: lsp.CompletionParams) {
        return Effect.promise(() =>
          conn.sendRequest<lsp.CompletionList | null>(
            lsp.CompletionRequest.method,
            params,
          ),
        );
      },

      requestFormatting(params: lsp.DocumentFormattingParams) {
        return Effect.promise(() =>
          conn.sendRequest<lsp.TextEdit[] | null>(
            lsp.DocumentFormattingRequest.method,
            params,
          ),
        );
      },

      requestRangeFormatting(params: lsp.DocumentRangeFormattingParams) {
        return Effect.promise(() =>
          conn.sendRequest<lsp.TextEdit[] | null>(
            lsp.DocumentRangeFormattingRequest.method,
            params,
          ),
        );
      },

      requestCodeAction(params: lsp.CodeActionParams) {
        return Effect.promise(() =>
          conn.sendRequest<lsp.CodeAction[] | null>(
            lsp.CodeActionRequest.method,
            params,
          ),
        );
      },

      requestCodeActionResolve(params: lsp.CodeAction) {
        return Effect.promise(() =>
          conn.sendRequest<lsp.CodeAction>(
            lsp.CodeActionResolveRequest.method,
            params,
          ),
        );
      },

      requestDefinition(params: lsp.DefinitionParams) {
        return Effect.promise(() =>
          conn.sendRequest<lsp.Definition | null>(
            lsp.DefinitionRequest.method,
            params,
          ),
        );
      },

      requestTypeDefinition(params: lsp.TypeDefinitionParams) {
        return Effect.promise(() =>
          conn.sendRequest<lsp.Definition | null>(
            lsp.TypeDefinitionRequest.method,
            params,
          ),
        );
      },

      requestDeclaration(params: lsp.DeclarationParams) {
        return Effect.promise(() =>
          conn.sendRequest<lsp.Declaration | null>(
            lsp.DeclarationRequest.method,
            params,
          ),
        );
      },

      requestReferences(params: lsp.ReferenceParams) {
        return Effect.promise(() =>
          conn.sendRequest<lsp.Location[] | null>(
            lsp.ReferencesRequest.method,
            params,
          ),
        );
      },

      requestRename(params: lsp.RenameParams) {
        return Effect.promise(() =>
          conn.sendRequest<lsp.WorkspaceEdit | null>(
            lsp.RenameRequest.method,
            params,
          ),
        );
      },

      requestPrepareRename(params: lsp.PrepareRenameParams) {
        return Effect.promise(() =>
          conn.sendRequest<lsp.Range | null>(
            lsp.PrepareRenameRequest.method,
            params,
          ),
        );
      },

      requestSignatureHelp(params: lsp.SignatureHelpParams) {
        return Effect.promise(() =>
          conn.sendRequest<lsp.SignatureHelp | null>(
            lsp.SignatureHelpRequest.method,
            params,
          ),
        );
      },

      requestDocumentHighlight(params: lsp.DocumentHighlightParams) {
        return Effect.promise(() =>
          conn.sendRequest<lsp.DocumentHighlight[] | null>(
            lsp.DocumentHighlightRequest.method,
            params,
          ),
        );
      },

      requestDocumentSymbol(params: lsp.DocumentSymbolParams) {
        return Effect.promise(() =>
          conn.sendRequest<lsp.DocumentSymbol[] | null>(
            lsp.DocumentSymbolRequest.method,
            params,
          ),
        );
      },

      requestInlayHint(params: lsp.InlayHintParams) {
        return Effect.promise(() =>
          conn.sendRequest<lsp.InlayHint[] | null>(
            lsp.InlayHintRequest.method,
            params,
          ),
        );
      },

      requestSemanticTokensFull(params: lsp.SemanticTokensParams) {
        return Effect.promise(() =>
          conn.sendRequest<lsp.SemanticTokens | null>(
            lsp.SemanticTokensRequest.method,
            params,
          ),
        );
      },

      requestSemanticTokensRange(params: lsp.SemanticTokensRangeParams) {
        return Effect.promise(() =>
          conn.sendRequest<lsp.SemanticTokens | null>(
            lsp.SemanticTokensRangeRequest.method,
            params,
          ),
        );
      },

      requestFoldingRange(params: lsp.FoldingRangeParams) {
        return Effect.promise(() =>
          conn.sendRequest<lsp.FoldingRange[] | null>(
            lsp.FoldingRangeRequest.method,
            params,
          ),
        );
      },

      requestSelectionRange(params: lsp.SelectionRangeParams) {
        return Effect.promise(() =>
          conn.sendRequest<lsp.SelectionRange[] | null>(
            lsp.SelectionRangeRequest.method,
            params,
          ),
        );
      },

      requestExecuteCommand(params: lsp.ExecuteCommandParams) {
        return Effect.promise(() =>
          conn.sendRequest<unknown>(lsp.ExecuteCommandRequest.method, params),
        );
      },

      // ---- Notifications stream -----------------------------------------

      diagnostics: Stream.fromPubSub(diagnosticsPubSub),
    };
  },
);

export type NotebookLspClient = Effect.Effect.Success<
  ReturnType<typeof makeNotebookLspClient>
>;
