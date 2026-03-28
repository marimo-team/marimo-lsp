/**
 * A minimal, Effect-based LSP client tailored for notebook document sync.
 *
 * Unlike vscode-languageclient's `LanguageClient`, this client owns the
 * full cell-ordering lifecycle. There is no internal `syncInfo` that can
 * diverge from what the server actually received — we track exactly what
 * we sent and update it atomically.
 *
 * Transport: stdio (stdin/stdout) via `vscode-jsonrpc`.
 * Protocol types: `vscode-languageserver-protocol`.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeProcess from "node:process";

import { Effect, HashMap, Ref } from "effect";
import * as rpc from "vscode-jsonrpc/node";
import * as lspTypes from "vscode-languageserver-protocol";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Identifies a notebook by its URI string. */
type NotebookUri = string;

/** The cells we last told the server about, in server order. */
type SyncedCells = ReadonlyArray<{
  uri: string;
  languageId: string;
  version: number;
  text: string;
  kind: number;
}>;

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
  capabilities: lspTypes.ServerCapabilities;
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

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        proc.kill();
      }),
    );

    // -- 2. Create JSON-RPC connection --------------------------------------

    // stdio: ["pipe", "pipe", "pipe"] guarantees these are non-null
    const stdout = proc.stdout;
    const stdin = proc.stdin;
    if (!stdout || !stdin) {
      return yield* Effect.die(
        new Error("Failed to get stdio streams from server process"),
      );
    }

    const connection = rpc.createMessageConnection(
      new rpc.StreamMessageReader(stdout),
      new rpc.StreamMessageWriter(stdin),
    );
    connection.listen();

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        connection.dispose();
      }),
    );

    // -- 3. Initialize handshake --------------------------------------------

    const initResult = yield* Effect.promise(() =>
      connection.sendRequest<lspTypes.InitializeResult>("initialize", {
        processId: NodeProcess.pid,
        capabilities: {
          general: {
            positionEncodings: [
              lspTypes.PositionEncodingKind.UTF32,
              lspTypes.PositionEncodingKind.UTF16,
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
                  lspTypes.DiagnosticTag.Unnecessary,
                  lspTypes.DiagnosticTag.Deprecated,
                ],
              },
            },
            codeAction: {
              codeActionLiteralSupport: {
                codeActionKind: {
                  valueSet: [
                    lspTypes.CodeActionKind.QuickFix,
                    lspTypes.CodeActionKind.SourceFixAll,
                    lspTypes.CodeActionKind.SourceOrganizeImports,
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
                  lspTypes.MarkupKind.Markdown,
                  lspTypes.MarkupKind.PlainText,
                ],
              },
            },
            hover: {
              contentFormat: [
                lspTypes.MarkupKind.Markdown,
                lspTypes.MarkupKind.PlainText,
              ],
            },
            signatureHelp: {
              signatureInformation: {
                documentationFormat: [
                  lspTypes.MarkupKind.Markdown,
                  lspTypes.MarkupKind.PlainText,
                ],
                parameterInformation: {
                  labelOffsetSupport: true,
                },
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
              formats: [lspTypes.TokenFormat.Relative],
            },
            inlayHint: { resolveSupport: { properties: [] } },
          },
          notebookDocument: {
            synchronization: {
              dynamicRegistration: false,
              executionSummarySupport: false,
            },
          },
          workspace: {
            workspaceFolders: true,
          },
        } satisfies lspTypes.ClientCapabilities,
        rootUri: config.workspaceFolders?.[0]?.uri ?? null,
        workspaceFolders:
          config.workspaceFolders?.map((f) => ({
            uri: f.uri,
            name: f.name,
          })) ?? null,
        initializationOptions: config.initializationOptions ?? {},
      } satisfies lspTypes.InitializeParams),
    );

    yield* Effect.promise(() => connection.sendNotification("initialized", {}));

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
        yield* Effect.promise(() => connection.sendRequest("shutdown")).pipe(
          Effect.timeout("5 seconds"),
          Effect.catchAll(() => Effect.void),
        );
        yield* Effect.promise(() => connection.sendNotification("exit")).pipe(
          Effect.catchAll(() => Effect.void),
        );
      }),
    );

    // -- 5. Cell order tracking ---------------------------------------------

    const cellOrderRef = yield* Ref.make(
      HashMap.empty<NotebookUri, SyncedCells>(),
    );

    // -- 6. Public API ------------------------------------------------------

    return {
      serverInfo,
      connection,

      /**
       * Send `notebookDocument/didOpen` with cells in the given order.
       * Stores the order for future diffs.
       */
      openNotebook: Effect.fn(function* (
        notebookUri: string,
        notebookVersion: number,
        cells: SyncedCells,
      ) {
        yield* Ref.update(cellOrderRef, HashMap.set(notebookUri, cells));

        yield* Effect.promise(() =>
          connection.sendNotification("notebookDocument/didOpen", {
            notebookDocument: {
              uri: notebookUri,
              notebookType: "marimo-notebook",
              version: notebookVersion,
              cells: cells.map((c) => ({
                kind:
                  c.kind === 2
                    ? lspTypes.NotebookCellKind.Code
                    : lspTypes.NotebookCellKind.Markup,
                document: c.uri,
              })),
            },
            cellTextDocuments: cells.map((c) => ({
              uri: c.uri,
              languageId: c.languageId,
              version: c.version,
              text: c.text,
            })),
          } satisfies lspTypes.DidOpenNotebookDocumentParams),
        );
      }),

      /**
       * Reorder cells for an already-open notebook.
       * Sends a structural `notebookDocument/didChange` that replaces all
       * cells with the new order, including `didOpen` so the server gets
       * fresh TextDocuments and re-lints.
       */
      reorderCells: Effect.fn(function* (
        notebookUri: string,
        notebookVersion: number,
        newCells: SyncedCells,
      ) {
        const current = yield* Ref.get(cellOrderRef).pipe(
          Effect.map(HashMap.get(notebookUri)),
        );

        if (current._tag === "None") {
          return; // Notebook not open yet
        }

        const oldCells = current.value;

        // Check if order actually changed
        if (
          oldCells.length === newCells.length &&
          oldCells.every((c, i) => c.uri === newCells[i].uri)
        ) {
          return; // Same order, skip
        }

        yield* Ref.update(cellOrderRef, HashMap.set(notebookUri, newCells));

        yield* Effect.promise(() =>
          connection.sendNotification("notebookDocument/didChange", {
            notebookDocument: { uri: notebookUri, version: notebookVersion },
            change: {
              cells: {
                structure: {
                  array: {
                    start: 0,
                    deleteCount: oldCells.length,
                    cells: newCells.map((c) => ({
                      kind:
                        c.kind === 2
                          ? lspTypes.NotebookCellKind.Code
                          : lspTypes.NotebookCellKind.Markup,
                      document: c.uri,
                    })),
                  },
                  didOpen: newCells.map((c) => ({
                    uri: c.uri,
                    languageId: c.languageId,
                    version: c.version,
                    text: c.text,
                  })),
                  didClose: [],
                },
              },
            },
          } satisfies lspTypes.DidChangeNotebookDocumentParams),
        );
      }),

      /**
       * Forward a text content change for a notebook cell.
       */
      changeCellText: Effect.fn(function* (
        notebookUri: string,
        notebookVersion: number,
        cellUri: string,
        cellVersion: number,
        changes: lspTypes.TextDocumentContentChangeEvent[],
      ) {
        yield* Effect.promise(() =>
          connection.sendNotification("notebookDocument/didChange", {
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
          } satisfies lspTypes.DidChangeNotebookDocumentParams),
        );
      }),

      /**
       * Send `notebookDocument/didClose`.
       */
      closeNotebook: Effect.fn(function* (notebookUri: string) {
        const current = yield* Ref.get(cellOrderRef).pipe(
          Effect.map(HashMap.get(notebookUri)),
        );

        yield* Ref.update(cellOrderRef, HashMap.remove(notebookUri));

        const cellUris =
          current._tag === "Some"
            ? current.value.map((c) => ({ uri: c.uri }))
            : [];

        yield* Effect.promise(() =>
          connection.sendNotification("notebookDocument/didClose", {
            notebookDocument: { uri: notebookUri },
            cellTextDocuments: cellUris,
          } satisfies lspTypes.DidCloseNotebookDocumentParams),
        );
      }),

      /**
       * Send an LSP request and return the response.
       */
      sendRequest<R>(method: string, params: unknown): Effect.Effect<R> {
        return Effect.promise(() => connection.sendRequest<R>(method, params));
      },

      /**
       * Register a handler for server notifications.
       */
      onNotification(
        method: string,
        handler: (params: unknown) => void,
      ): rpc.Disposable {
        return connection.onNotification(method, handler);
      },
    };
  },
);

export type NotebookLspClient = Effect.Effect.Success<
  ReturnType<typeof makeNotebookLspClient>
>;
