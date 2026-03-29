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
import * as NodeReadline from "node:readline";

import { Effect, HashMap, Option, PubSub, Ref, Runtime, Stream } from "effect";
import type * as vscode from "vscode";
import * as rpc from "vscode-jsonrpc/node";
import * as lsp from "vscode-languageserver-protocol";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Maps LSP request methods to their `[Params, Result]` types.
 *
 * This is the union of all request methods supported by Ruff and ty.
 * Adding an entry here automatically makes it available via
 * `client.sendRequest(method, params)` with full type safety.
 */
export type LspRequestMap = {
  [lsp.HoverRequest.method]: [lsp.HoverParams, lsp.Hover | null];
  [lsp.CompletionRequest.method]: [
    lsp.CompletionParams,
    lsp.CompletionList | null,
  ];
  [lsp.DocumentFormattingRequest.method]: [
    lsp.DocumentFormattingParams,
    lsp.TextEdit[] | null,
  ];
  [lsp.DocumentRangeFormattingRequest.method]: [
    lsp.DocumentRangeFormattingParams,
    lsp.TextEdit[] | null,
  ];
  [lsp.CodeActionRequest.method]: [
    lsp.CodeActionParams,
    (lsp.Command | lsp.CodeAction)[] | null,
  ];
  [lsp.CodeActionResolveRequest.method]: [lsp.CodeAction, lsp.CodeAction];
  [lsp.DefinitionRequest.method]: [lsp.DefinitionParams, lsp.Definition | null];
  [lsp.TypeDefinitionRequest.method]: [
    lsp.TypeDefinitionParams,
    lsp.Definition | null,
  ];
  [lsp.DeclarationRequest.method]: [
    lsp.DeclarationParams,
    lsp.Declaration | null,
  ];
  [lsp.ReferencesRequest.method]: [lsp.ReferenceParams, lsp.Location[] | null];
  [lsp.RenameRequest.method]: [lsp.RenameParams, lsp.WorkspaceEdit | null];
  [lsp.PrepareRenameRequest.method]: [
    lsp.PrepareRenameParams,
    lsp.Range | null,
  ];
  [lsp.SignatureHelpRequest.method]: [
    lsp.SignatureHelpParams,
    lsp.SignatureHelp | null,
  ];
  [lsp.DocumentHighlightRequest.method]: [
    lsp.DocumentHighlightParams,
    lsp.DocumentHighlight[] | null,
  ];
  [lsp.DocumentSymbolRequest.method]: [
    lsp.DocumentSymbolParams,
    lsp.DocumentSymbol[] | null,
  ];
  [lsp.InlayHintRequest.method]: [lsp.InlayHintParams, lsp.InlayHint[] | null];
  [lsp.SemanticTokensRequest.method]: [
    lsp.SemanticTokensParams,
    lsp.SemanticTokens | null,
  ];
  [lsp.SemanticTokensRangeRequest.method]: [
    lsp.SemanticTokensRangeParams,
    lsp.SemanticTokens | null,
  ];
  [lsp.FoldingRangeRequest.method]: [
    lsp.FoldingRangeParams,
    lsp.FoldingRange[] | null,
  ];
  [lsp.SelectionRangeRequest.method]: [
    lsp.SelectionRangeParams,
    lsp.SelectionRange[] | null,
  ];
  [lsp.ExecuteCommandRequest.method]: [lsp.ExecuteCommandParams, unknown];
};

type NotebookUri = string;

/** The cells we last told the server about, in server order. */
export interface SyncedCell {
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
  /** Notebook type identifier (e.g. "marimo-notebook"). */
  notebookType: string;
  /** Output channel for server log messages. */
  outputChannel?: vscode.LogOutputChannel;
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
    // -- 1. Spawn process ---------------------------------------------------

    const proc = NodeChildProcess.spawn(config.command, config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...NodeProcess.env, ...config.env },
    });

    yield* Effect.addFinalizer(() => Effect.sync(() => proc.kill()));

    // Pipe stderr to output channel, line by line (matches LanguageClient behavior)
    if (config.outputChannel && proc.stderr) {
      const channel = config.outputChannel;
      const it = NodeReadline.createInterface({
        input: proc.stderr,
        crlfDelay: Number.POSITIVE_INFINITY,
        terminal: false,
        historySize: 0,
      });
      it.on("line", (data) => channel.error(data));
    }

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

    const runFork = Runtime.runFork(yield* Effect.runtime());
    conn.onNotification(
      lsp.PublishDiagnosticsNotification.method,
      (params: lsp.PublishDiagnosticsParams) => {
        runFork(PubSub.publish(diagnosticsPubSub, params));
      },
    );

    // -- 6b. Server log messages → output channel ---------------------------

    const out = config.outputChannel;
    if (out) {
      conn.onNotification(
        lsp.LogMessageNotification.method,
        (params: lsp.LogMessageParams) => {
          switch (params.type) {
            case lsp.MessageType.Error:
              out.error(params.message);
              break;
            case lsp.MessageType.Warning:
              out.warn(params.message);
              break;
            case lsp.MessageType.Info:
              out.info(params.message);
              break;
            case lsp.MessageType.Log:
            default:
              out.debug(params.message);
              break;
          }
        },
      );
    }

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

    // -- 8. Notebook sync helpers -------------------------------------------

    const sendDidOpen = (
      uri: string,
      version: number,
      cells: ReadonlyArray<SyncedCell>,
    ) =>
      Effect.promise(() =>
        conn.sendNotification("notebookDocument/didOpen", {
          notebookDocument: {
            uri,
            notebookType: config.notebookType,
            version,
            cells: cells.map((c) => toLspCell(c)),
          },
          cellTextDocuments: cells.map((c) => toLspTextDocument(c)),
        } satisfies lsp.DidOpenNotebookDocumentParams),
      );

    const sendDidClose = (uri: string, cells: ReadonlyArray<SyncedCell>) =>
      Effect.promise(() =>
        conn.sendNotification("notebookDocument/didClose", {
          notebookDocument: { uri },
          cellTextDocuments: cells.map((c) => ({ uri: c.uri })),
        } satisfies lsp.DidCloseNotebookDocumentParams),
      );

    // -- 9. Public API ------------------------------------------------------

    return {
      serverInfo,

      // ---- Notebook sync ------------------------------------------------

      openNotebook: Effect.fn(function* (
        notebookUri: string,
        notebookVersion: number,
        cells: ReadonlyArray<SyncedCell>,
      ) {
        yield* Ref.update(cellOrderRef, HashMap.set(notebookUri, cells));
        yield* sendDidOpen(notebookUri, notebookVersion, cells);
      }),

      /**
       * Reorder cells by closing and reopening the notebook.
       *
       * A structural `notebookDocument/didChange` would be more efficient,
       * but both Ruff and ty use a reverse-insertion algorithm that produces
       * swapped diagnostic-to-cell URI mappings. A clean close + open
       * sidesteps this entirely.
       */
      reorderCells: Effect.fn(function* (
        notebookUri: string,
        notebookVersion: number,
        newCells: ReadonlyArray<SyncedCell>,
      ) {
        const current = HashMap.get(yield* Ref.get(cellOrderRef), notebookUri);
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

        yield* sendDidClose(notebookUri, oldCells);
        yield* Ref.update(cellOrderRef, HashMap.set(notebookUri, newCells));
        yield* sendDidOpen(notebookUri, notebookVersion, newCells);
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
        if (Option.isSome(current)) {
          yield* sendDidClose(notebookUri, current.value);
        }
      }),

      // ---- Typed requests -----------------------------------------------

      /**
       * Send a typed LSP request. The method string determines
       * the param/result types via {@link LspRequestMap}.
       */
      sendRequest<M extends keyof LspRequestMap>(
        method: M,
        params: LspRequestMap[M][0],
      ): Effect.Effect<LspRequestMap[M][1]> {
        // eslint-disable-next-line -- cast needed: conn.sendRequest returns Promise<any>
        return Effect.promise(() => conn.sendRequest(method, params)) as any;
      },

      // ---- Notifications stream -----------------------------------------

      diagnostics: Stream.fromPubSub(diagnosticsPubSub),
    };
  },
);

export type NotebookLspClient = Effect.Effect.Success<
  ReturnType<typeof makeNotebookLspClient>
>;
