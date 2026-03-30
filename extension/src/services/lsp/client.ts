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

import {
  Data,
  Effect,
  HashMap,
  Option,
  PubSub,
  Ref,
  Runtime,
  Stream,
  SubscriptionRef,
} from "effect";
import type * as vscode from "vscode";
import * as rpc from "vscode-jsonrpc/node";
import * as lsp from "vscode-languageserver-protocol";

import { NOTEBOOK_TYPE } from "../../constants.ts";
import { MarimoNotebookDocument, type NotebookId } from "../../schemas.ts";
import { getTopologicalCells } from "../../utils/getTopologicalCells.ts";
import { VariablesService } from "../variables/VariablesService.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Typed error for LSP request failures.
 *
 * Wraps `vscode-jsonrpc`'s `ResponseError` — the server returned an error
 * response, the connection died mid-request, or the request couldn't be
 * written. The `code` field carries the JSON-RPC error code (e.g. -32601
 * for MethodNotFound).
 */
export class LspRequestError extends Data.TaggedError("LspRequestError")<{
  readonly method: string;
  readonly code: number;
  readonly message: string;
}> {}

function hasCode(value: unknown): value is { code: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "number"
  );
}

function getErrorCode(cause: unknown): number {
  return hasCode(cause) ? cause.code : -1;
}

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
  [lsp.CompletionResolveRequest.method]: [
    lsp.CompletionItem,
    lsp.CompletionItem,
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
    (
      | lsp.Range
      | { range: lsp.Range; placeholder: string }
      | { defaultBehavior: boolean }
      | null
    ),
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
  [lsp.InlayHintResolveRequest.method]: [lsp.InlayHint, lsp.InlayHint];
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
  /** Output channel for server log messages. */
  outputChannel: vscode.OutputChannel;
  /**
   * Handler for `workspace/configuration` requests from the server.
   *
   * The server sends a list of `{ section, scopeUri }` items and expects
   * a configuration value for each. If not provided, the client responds
   * with `null` for every item.
   */
  onConfigurationRequest?: (
    params: lsp.ConfigurationParams,
  ) => Effect.Effect<unknown[]>;
}

/** Internal config with resolved workspace folders. */
interface InternalLspClientConfig extends NotebookLspClientConfig {
  workspaceFolders: ReadonlyArray<{ uri: string; name: string }>;
}

export interface ServerInfo {
  name: string;
  version: string;
  capabilities: lsp.ServerCapabilities;
}

// ---------------------------------------------------------------------------
// LSP type converters (pure, no dependencies)
// ---------------------------------------------------------------------------

/**
 * Converts VS Code notebook cells to LSP wire types.
 * Normalizes `mo-python` → `python` for the server.
 */
const LspCell = {
  /** Convert to the cell reference used in structural array changes. */
  toNotebookCell: (c: vscode.NotebookCell) => ({
    kind:
      (c.kind as number) === 2
        ? lsp.NotebookCellKind.Code
        : lsp.NotebookCellKind.Markup,
    document: c.document.uri.toString(),
  }),
  /** Convert to a full text document item (for didOpen). */
  toTextDocumentItem: (c: vscode.NotebookCell) => ({
    uri: c.document.uri.toString(),
    languageId:
      c.document.languageId === "mo-python" ? "python" : c.document.languageId,
    version: c.document.version,
    text: c.document.getText(),
  }),
} as const;

function uriEquals(a: vscode.Uri, b: vscode.Uri) {
  return a.toString() === b.toString();
}

// ---------------------------------------------------------------------------
// Notebook registry
// ---------------------------------------------------------------------------

/**
 * Tracks which marimo notebooks are currently open.
 *
 * Provides efficient lookup by notebook ID and by cell URI (to find
 * the parent notebook of a cell text document change).
 */
const makeMarimoNotebookRegistry = Effect.gen(function* () {
  const ref = yield* Ref.make(
    HashMap.empty<NotebookId, MarimoNotebookDocument>(),
  );
  return {
    create: (doc: MarimoNotebookDocument) =>
      Ref.update(ref, HashMap.set(doc.id, doc)),
    delete: (doc: MarimoNotebookDocument) =>
      Ref.update(ref, HashMap.remove(doc.id)),
    get: (id: NotebookId) => Effect.map(Ref.get(ref), HashMap.get(id)),
    getFromCell: (cellUri: vscode.Uri) =>
      Effect.map(Ref.get(ref), (notebooks) => {
        for (const doc of HashMap.values(notebooks)) {
          if (doc.getCells().some((c) => uriEquals(cellUri, c.document.uri))) {
            return Option.some(doc);
          }
        }
        return Option.none();
      }),
  };
});

// ---------------------------------------------------------------------------
// Dynamic capability registration
// ---------------------------------------------------------------------------

/**
 * Tracks dynamic capability registrations from the server
 * (`client/registerCapability` and `client/unregisterCapability`).
 *
 * Wires up the JSON-RPC request handlers on the connection and stores
 * registrations in a `Ref<HashMap>`.
 */
function makeDynamicRegistrations(conn: rpc.MessageConnection) {
  return Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make(
      HashMap.empty<string, ReadonlyArray<lsp.Registration>>(),
    );
    const runFork = Runtime.runFork(yield* Effect.runtime());

    conn.onRequest(
      lsp.RegistrationRequest.method,
      (params: lsp.RegistrationParams) => {
        runFork(
          SubscriptionRef.update(ref, (regs) => {
            let updated = regs;
            for (const reg of params.registrations) {
              const existing = HashMap.get(updated, reg.method);
              updated = HashMap.set(
                updated,
                reg.method,
                Option.isSome(existing) ? [...existing.value, reg] : [reg],
              );
            }
            return updated;
          }),
        );
      },
    );

    conn.onRequest(
      lsp.UnregistrationRequest.method,
      (params: lsp.UnregistrationParams) => {
        runFork(
          SubscriptionRef.update(ref, (regs) => {
            let updated = regs;
            for (const unreg of params.unregisterations) {
              const existing = HashMap.get(updated, unreg.method);
              if (Option.isSome(existing)) {
                const filtered = existing.value.filter(
                  (r) => r.id !== unreg.id,
                );
                updated =
                  filtered.length > 0
                    ? HashMap.set(updated, unreg.method, filtered)
                    : HashMap.remove(updated, unreg.method);
              }
            }
            return updated;
          }),
        );
      },
    );
    return {
      /** Check if the server has registered a specific method dynamically. */
      has: (method: string) =>
        Effect.map(SubscriptionRef.get(ref), HashMap.has(method)),
      /** Get all registrations for a method. */
      get: (method: string) =>
        Effect.map(SubscriptionRef.get(ref), HashMap.get(method)),
      /**
       * Wait for a specific method to be registered, then return its
       * registrations. Completes immediately if already registered.
       */
      await: (method: string) =>
        ref.changes.pipe(
          Stream.map(HashMap.get(method)),
          Stream.filter(Option.isSome),
          Stream.take(1),
          Stream.runHead,
          // Safe to unwrap — we took 1 element that passed the filter
          Effect.map((opt) => (Option.isSome(opt) ? opt.value.value : [])),
        ),
    };
  });
}

// ---------------------------------------------------------------------------
// Client capabilities
// ---------------------------------------------------------------------------

/**
 * Client capabilities sent in the initialize request.
 *
 * Matches what vscode-languageclient's `LanguageClient` sends, with two
 * additions: UTF-32 position encoding (preferred by both Ruff and ty)
 * and notebook-specific code action kinds.
 */
function clientCapabilities(): lsp.ClientCapabilities {
  const markdownAndPlaintext = [
    lsp.MarkupKind.Markdown,
    lsp.MarkupKind.PlainText,
  ];
  return {
    general: {
      positionEncodings: [
        lsp.PositionEncodingKind.UTF32,
        lsp.PositionEncodingKind.UTF16,
      ],
      staleRequestSupport: {
        cancel: true,
        retryOnContentModified: [
          lsp.SemanticTokensRequest.method,
          lsp.SemanticTokensRangeRequest.method,
        ],
      },
      regularExpressions: {
        engine: "ECMAScript",
        version: "ES2020",
      },
    },
    textDocument: {
      synchronization: {
        dynamicRegistration: false,
        didSave: false,
      },
      publishDiagnostics: {
        relatedInformation: true,
        versionSupport: false,
        codeDescriptionSupport: true,
        dataSupport: true,
        tagSupport: {
          valueSet: [
            lsp.DiagnosticTag.Unnecessary,
            lsp.DiagnosticTag.Deprecated,
          ],
        },
      },
      completion: {
        completionItem: {
          snippetSupport: false,
          commitCharactersSupport: true,
          documentationFormat: markdownAndPlaintext,
          deprecatedSupport: true,
          preselectSupport: true,
          tagSupport: {
            valueSet: [lsp.CompletionItemTag.Deprecated],
          },
          insertReplaceSupport: true,
          resolveSupport: {
            properties: ["documentation", "detail", "additionalTextEdits"],
          },
          insertTextModeSupport: {
            valueSet: [
              lsp.InsertTextMode.asIs,
              lsp.InsertTextMode.adjustIndentation,
            ],
          },
          labelDetailsSupport: true,
        },
        completionItemKind: {
          valueSet: [
            lsp.CompletionItemKind.Text,
            lsp.CompletionItemKind.Method,
            lsp.CompletionItemKind.Function,
            lsp.CompletionItemKind.Constructor,
            lsp.CompletionItemKind.Field,
            lsp.CompletionItemKind.Variable,
            lsp.CompletionItemKind.Class,
            lsp.CompletionItemKind.Interface,
            lsp.CompletionItemKind.Module,
            lsp.CompletionItemKind.Property,
            lsp.CompletionItemKind.Unit,
            lsp.CompletionItemKind.Value,
            lsp.CompletionItemKind.Enum,
            lsp.CompletionItemKind.Keyword,
            lsp.CompletionItemKind.Snippet,
            lsp.CompletionItemKind.Color,
            lsp.CompletionItemKind.File,
            lsp.CompletionItemKind.Reference,
            lsp.CompletionItemKind.Folder,
            lsp.CompletionItemKind.EnumMember,
            lsp.CompletionItemKind.Constant,
            lsp.CompletionItemKind.Struct,
            lsp.CompletionItemKind.Event,
            lsp.CompletionItemKind.Operator,
            lsp.CompletionItemKind.TypeParameter,
          ],
        },
        contextSupport: true,
        completionList: {
          itemDefaults: [
            "commitCharacters",
            "editRange",
            "insertTextFormat",
            "insertTextMode",
            "data",
          ],
        },
      },
      hover: {
        contentFormat: markdownAndPlaintext,
      },
      signatureHelp: {
        signatureInformation: {
          documentationFormat: markdownAndPlaintext,
          parameterInformation: { labelOffsetSupport: true },
          activeParameterSupport: true,
        },
      },
      definition: { linkSupport: true },
      typeDefinition: { linkSupport: true },
      declaration: { linkSupport: true },
      references: {},
      documentHighlight: {},
      documentSymbol: {
        hierarchicalDocumentSymbolSupport: true,
        symbolKind: {
          valueSet: [
            lsp.SymbolKind.File,
            lsp.SymbolKind.Module,
            lsp.SymbolKind.Namespace,
            lsp.SymbolKind.Package,
            lsp.SymbolKind.Class,
            lsp.SymbolKind.Method,
            lsp.SymbolKind.Property,
            lsp.SymbolKind.Field,
            lsp.SymbolKind.Constructor,
            lsp.SymbolKind.Enum,
            lsp.SymbolKind.Interface,
            lsp.SymbolKind.Function,
            lsp.SymbolKind.Variable,
            lsp.SymbolKind.Constant,
            lsp.SymbolKind.String,
            lsp.SymbolKind.Number,
            lsp.SymbolKind.Boolean,
            lsp.SymbolKind.Array,
            lsp.SymbolKind.Object,
            lsp.SymbolKind.Key,
            lsp.SymbolKind.Null,
            lsp.SymbolKind.EnumMember,
            lsp.SymbolKind.Struct,
            lsp.SymbolKind.Event,
            lsp.SymbolKind.Operator,
            lsp.SymbolKind.TypeParameter,
          ],
        },
        labelSupport: true,
      },
      codeAction: {
        codeActionLiteralSupport: {
          codeActionKind: {
            valueSet: [
              lsp.CodeActionKind.QuickFix,
              lsp.CodeActionKind.Refactor,
              lsp.CodeActionKind.Source,
              lsp.CodeActionKind.SourceFixAll,
              lsp.CodeActionKind.SourceOrganizeImports,
              "notebook.source.fixAll",
              "notebook.source.organizeImports",
            ],
          },
        },
        isPreferredSupport: true,
        disabledSupport: true,
        dataSupport: true,
        resolveSupport: { properties: ["edit"] },
      },
      formatting: {},
      rangeFormatting: {},
      rename: { prepareSupport: true },
      foldingRange: {
        lineFoldingOnly: true,
        foldingRangeKind: {
          valueSet: [
            lsp.FoldingRangeKind.Comment,
            lsp.FoldingRangeKind.Imports,
            lsp.FoldingRangeKind.Region,
          ],
        },
      },
      selectionRange: {},
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
        tokenModifiers: ["definition", "readonly", "async", "documentation"],
        formats: [lsp.TokenFormat.Relative],
        multilineTokenSupport: false,
        overlappingTokenSupport: false,
      },
      inlayHint: {
        resolveSupport: { properties: [] },
      },
    },
    notebookDocument: {
      synchronization: {
        dynamicRegistration: false,
        executionSummarySupport: false,
      },
    },
    workspace: {
      applyEdit: true,
      workspaceEdit: {
        documentChanges: true,
        resourceOperations: [
          lsp.ResourceOperationKind.Create,
          lsp.ResourceOperationKind.Rename,
          lsp.ResourceOperationKind.Delete,
        ],
        failureHandling: lsp.FailureHandlingKind.TextOnlyTransactional,
        normalizesLineEndings: true,
        changeAnnotationSupport: { groupsOnLabel: true },
      },
      workspaceFolders: true,
      configuration: true,
      didChangeConfiguration: { dynamicRegistration: true },
      didChangeWatchedFiles: {
        dynamicRegistration: true,
        relativePatternSupport: true,
      },
    },
  };
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
  function* (config: InternalLspClientConfig) {
    const out = config.outputChannel;
    const runPromise = Runtime.runPromise(yield* Effect.runtime());

    // -- 1. Spawn process ---------------------------------------------------

    const proc = NodeChildProcess.spawn(config.command, config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...NodeProcess.env, ...config.env },
    });

    yield* Effect.addFinalizer(() => Effect.sync(() => proc.kill()));

    // Pipe stderr to output channel, line by line
    if (proc.stderr) {
      NodeReadline.createInterface({
        input: proc.stderr,
        crlfDelay: Number.POSITIVE_INFINITY,
        terminal: false,
        historySize: 0,
      }).on("line", (data) => out.appendLine(data));
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
        capabilities: clientCapabilities(),
        rootUri: config.workspaceFolders[0]?.uri ?? null,
        workspaceFolders:
          config.workspaceFolders.length > 0
            ? config.workspaceFolders.map((f) => ({ uri: f.uri, name: f.name }))
            : null,
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

    // -- 4. Server → client request handlers --------------------------------

    conn.onRequest(
      lsp.ConfigurationRequest.method,
      (params: lsp.ConfigurationParams) => {
        if (config.onConfigurationRequest) {
          return runPromise(config.onConfigurationRequest(params));
        }
        return params.items.map(() => null);
      },
    );

    // -- 4b. Dynamic capability registration --------------------------------

    const registrations = yield* makeDynamicRegistrations(conn);

    // -- 5. Shutdown finalizer (graceful before kill) -----------------------

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

    // -- 5. State tracking ---------------------------------------------------

    const variables = yield* VariablesService;

    const cellOrderRef = yield* Ref.make(
      HashMap.empty<NotebookId, Array<vscode.Uri>>(),
    );
    const registry = yield* makeMarimoNotebookRegistry;

    // -- 6. Diagnostics stream ----------------------------------------------

    const diagnosticsPubSub =
      yield* PubSub.unbounded<lsp.PublishDiagnosticsParams>();
    conn.onNotification(
      lsp.PublishDiagnosticsNotification.method,
      (params: lsp.PublishDiagnosticsParams) => {
        void runPromise(PubSub.publish(diagnosticsPubSub, params));
      },
    );

    // -- 6b. Server log messages → output channel ---------------------------

    conn.onNotification(
      lsp.LogMessageNotification.method,
      (params: lsp.LogMessageParams) => out.appendLine(params.message),
    );

    // -- 7. Internal notebook sync ------------------------------------------

    const sendDidOpen = (
      doc: MarimoNotebookDocument,
      cells: ReadonlyArray<vscode.NotebookCell>,
    ) =>
      Effect.promise(() =>
        conn.sendNotification("notebookDocument/didOpen", {
          notebookDocument: {
            uri: doc.uri.toString(),
            notebookType: NOTEBOOK_TYPE,
            version: doc.rawNotebookDocument.version,
            cells: cells.map(LspCell.toNotebookCell),
          },
          cellTextDocuments: cells.map(LspCell.toTextDocumentItem),
        } satisfies lsp.DidOpenNotebookDocumentParams),
      );

    const sendDidClose = (
      doc: MarimoNotebookDocument,
      cellUris: Array<vscode.Uri>,
    ) =>
      Effect.promise(() =>
        conn.sendNotification("notebookDocument/didClose", {
          notebookDocument: { uri: doc.uri.toString() },
          cellTextDocuments: cellUris.map((uri) => ({ uri: uri.toString() })),
        } satisfies lsp.DidCloseNotebookDocumentParams),
      );

    /**
     * Reorder cells by closing and reopening the notebook.
     *
     * A structural `notebookDocument/didChange` would be more efficient,
     * but both Ruff and ty use a reverse-insertion algorithm that produces
     * swapped diagnostic-to-cell URI mappings. A clean close + open
     * sidesteps this entirely.
     */
    const reorderNotebook = Effect.fn(function* (doc: MarimoNotebookDocument) {
      const current = HashMap.get(yield* Ref.get(cellOrderRef), doc.id);
      if (Option.isNone(current)) {
        return;
      }

      const newCells = yield* getTopologicalCells(doc);
      const newCellUris = newCells.map((c) => c.document.uri);
      const oldUris = current.value;

      if (
        oldUris.length === newCells.length &&
        oldUris.every((uri, i) => uriEquals(uri, newCellUris[i]))
      ) {
        return;
      }

      yield* sendDidClose(doc, oldUris);
      yield* Ref.update(cellOrderRef, HashMap.set(doc.id, newCellUris));
      yield* sendDidOpen(doc, newCells);
    });

    // -- 8. Variable subscription → reorder ---------------------------------

    yield* Effect.forkScoped(
      variables.notebookUpdates().pipe(
        Stream.filter((evt) => evt.kind === "declaration"),
        Stream.mapEffect(
          Effect.fnUntraced(function* (evt) {
            const doc = yield* registry.get(evt.notebookId);
            if (Option.isSome(doc)) {
              yield* reorderNotebook(doc.value);
            }
          }),
        ),
        Stream.runDrain,
      ),
    );

    // -- 9. Public API ------------------------------------------------------

    return {
      serverInfo,
      registrations,

      // ---- Notebook lifecycle -------------------------------------------

      openNotebookDocument: Effect.fn(function* (doc: MarimoNotebookDocument) {
        const cells = yield* getTopologicalCells(doc);
        const uris = cells.map((c) => c.document.uri);
        yield* registry.create(doc);
        yield* Ref.update(cellOrderRef, HashMap.set(doc.id, uris));
        yield* sendDidOpen(doc, cells);
      }),

      closeNotebookDocument: Effect.fn(function* (doc: MarimoNotebookDocument) {
        const current = HashMap.get(yield* Ref.get(cellOrderRef), doc.id);
        yield* Ref.update(cellOrderRef, HashMap.remove(doc.id));
        yield* registry.delete(doc);
        if (Option.isSome(current)) {
          yield* sendDidClose(doc, current.value);
        }
      }),

      /** Handle structural notebook changes (cells added/removed). */
      notebookDocumentChange: Effect.fn(function* (
        evt: vscode.NotebookDocumentChangeEvent,
      ) {
        if (evt.contentChanges.length === 0) return;
        const doc = MarimoNotebookDocument.tryFrom(evt.notebook);
        if (Option.isNone(doc)) return;
        yield* reorderNotebook(doc.value);
      }),

      /** Forward incremental text edits within a notebook cell. */
      textDocumentChange: Effect.fn(function* (
        evt: vscode.TextDocumentChangeEvent,
      ) {
        const doc = yield* registry.getFromCell(evt.document.uri);
        if (Option.isNone(doc)) {
          return;
        }

        yield* Effect.promise(() =>
          conn.sendNotification("notebookDocument/didChange", {
            notebookDocument: {
              uri: doc.value.uri.toString(),
              version: doc.value.rawNotebookDocument.version,
            },
            change: {
              cells: {
                textContent: [
                  {
                    document: {
                      uri: evt.document.uri.toString(),
                      version: evt.document.version,
                    },
                    changes: evt.contentChanges.map((c) => ({
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
                  },
                ],
              },
            },
          } satisfies lsp.DidChangeNotebookDocumentParams),
        );
      }),

      // ---- Typed requests -----------------------------------------------

      /**
       * Send a typed LSP request. Logs and returns `null` on failure
       * (server error, connection lost, etc.) so providers can treat
       * errors the same as "no results".
       */
      sendRequest<M extends keyof LspRequestMap>(
        method: M,
        params: LspRequestMap[M][0],
      ): Effect.Effect<LspRequestMap[M][1]> {
        return Effect.tryPromise({
          try: () => conn.sendRequest(method, params),
          catch: (cause) =>
            new LspRequestError({
              method,
              code: getErrorCode(cause),
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        }).pipe(
          Effect.catchTag("LspRequestError", (err) =>
            Effect.logDebug("LSP request failed").pipe(
              Effect.annotateLogs({ method: err.method, code: err.code }),
              Effect.as(null as LspRequestMap[M][1]),
            ),
          ),
        );
      },

      /** Send a raw notification to the server. */
      sendNotification(method: string, params: unknown) {
        return Effect.promise(() => conn.sendNotification(method, params));
      },

      // ---- Notifications stream -----------------------------------------

      diagnostics: Stream.fromPubSub(diagnosticsPubSub),
    };
  },
);

export type NotebookLspClient = Effect.Effect.Success<
  ReturnType<typeof makeNotebookLspClient>
>;
