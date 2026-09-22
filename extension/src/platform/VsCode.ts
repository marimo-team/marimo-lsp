import {
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Result,
  Scope,
  Stream,
} from "effect";

declare global {
  // oxlint-disable-next-line eslint/no-var, eslint/no-underscore-dangle
  var __marimoVsCode: typeof vscode | undefined;
}
// VsCode.ts centralizes and restricts access to the VS Code API.
//
// All other modules should use type-only imports and access the API through this service.
//
// We only expose the APIs we actually need. Being selective gives us a cleaner,
// easier testing story. The goal is NOT to hide APIs that are hard to mock,
// but to limit surface area to what's necessary for correctness and clarity.
//
// oxlint-disable-next-line marimo/vscode-type-only
import * as vscode from "vscode";

import { acquireDisposable } from "../lib/acquireDisposable.ts";
import { signalFromToken } from "../lib/signalFromToken.ts";
import * as Commands from "./Commands.ts";
import * as Debug from "./Debug.ts";
import * as Env from "./Env.ts";
import * as Window from "./Window.ts";
import * as Workspace from "./Workspace.ts";

export class Notebooks extends Context.Service<Notebooks>()("Notebooks", {
  make: Effect.gen(function* () {
    const api = vscode.notebooks;
    const runPromise = Effect.runPromiseWith(yield* Effect.context());
    return {
      createRendererMessaging(rendererId: string) {
        return Effect.succeed(api.createRendererMessaging(rendererId));
      },
      createNotebookController(
        id: string,
        notebookType: string,
        label: string,
      ): Effect.Effect<
        Omit<vscode.NotebookController, "dispose">,
        never,
        Scope.Scope
      > {
        return acquireDisposable(() =>
          api.createNotebookController(id, notebookType, label),
        );
      },
      registerNotebookCellStatusBarItemProvider(
        notebookType: string,
        impl: {
          provideCellStatusBarItems(
            cell: vscode.NotebookCell,
          ): Effect.Effect<vscode.NotebookCellStatusBarItem[]>;
          changes: Stream.Stream<void>;
        },
      ) {
        return Effect.gen(function* () {
          const emitter = yield* acquireDisposable(
            () => new vscode.EventEmitter<void>(),
          );
          yield* Effect.forkScoped(
            impl.changes.pipe(
              Stream.runForEach(() => Effect.succeed(emitter.fire())),
            ),
          );
          yield* acquireDisposable(() =>
            api.registerNotebookCellStatusBarItemProvider(notebookType, {
              onDidChangeCellStatusBarItems: emitter.event,
              provideCellStatusBarItems: (cell, token) =>
                runPromise(impl.provideCellStatusBarItems(cell), {
                  signal: signalFromToken(token),
                }),
            }),
          );
        });
      },
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export class AuthError extends Data.TaggedError("AuthError")<{
  cause: unknown;
}> {}

export class Auth extends Context.Service<Auth>()("Auth", {
  make: Effect.sync(() => {
    const api = vscode.authentication;
    return {
      getSession(
        providerId: "github" | "microsoft", // could be custom but these are default
        scopes: ReadonlyArray<string>,
        options: vscode.AuthenticationGetSessionOptions,
      ) {
        return Effect.map(
          Effect.tryPromise({
            try: () => api.getSession(providerId, scopes, options),
            catch: (cause) => new AuthError({ cause }),
          }),
          Option.fromNullishOr,
        );
      },
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export class Languages extends Context.Service<Languages>()("Languages", {
  make: Effect.gen(function* () {
    const api = vscode.languages;
    const runPromise = Effect.runPromiseWith(yield* Effect.context());
    return {
      registerCodeLensProvider(
        selector: vscode.DocumentSelector,
        provider: vscode.CodeLensProvider,
      ) {
        return acquireDisposable(() =>
          api.registerCodeLensProvider(selector, provider),
        ).pipe(Effect.asVoid);
      },
      createDiagnosticCollection(name: string) {
        return api.createDiagnosticCollection(name);
      },
      registerHoverProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideHover(
            doc: vscode.TextDocument,
            pos: vscode.Position,
          ): Effect.Effect<vscode.Hover | undefined>;
        },
      ) {
        return acquireDisposable(() =>
          api.registerHoverProvider(selector, {
            provideHover(doc, pos, tok) {
              return runPromise(impl.provideHover(doc, pos), {
                signal: signalFromToken(tok),
              });
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerDefinitionProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideDefinition(
            doc: vscode.TextDocument,
            pos: vscode.Position,
          ): Effect.Effect<
            vscode.Definition | vscode.DefinitionLink[] | undefined
          >;
        },
      ) {
        return acquireDisposable(() =>
          api.registerDefinitionProvider(selector, {
            provideDefinition(doc, pos, tok) {
              return runPromise(impl.provideDefinition(doc, pos), {
                signal: signalFromToken(tok),
              });
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerDeclarationProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideDeclaration(
            doc: vscode.TextDocument,
            pos: vscode.Position,
          ): Effect.Effect<
            vscode.Declaration | vscode.LocationLink[] | undefined
          >;
        },
      ) {
        return acquireDisposable(() =>
          api.registerDeclarationProvider(selector, {
            provideDeclaration(doc, pos, tok) {
              return runPromise(impl.provideDeclaration(doc, pos), {
                signal: signalFromToken(tok),
              });
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerTypeDefinitionProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideTypeDefinition(
            doc: vscode.TextDocument,
            pos: vscode.Position,
          ): Effect.Effect<
            vscode.Definition | vscode.DefinitionLink[] | undefined
          >;
        },
      ) {
        return acquireDisposable(() =>
          api.registerTypeDefinitionProvider(selector, {
            provideTypeDefinition(doc, pos, tok) {
              return runPromise(impl.provideTypeDefinition(doc, pos), {
                signal: signalFromToken(tok),
              });
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerReferenceProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideReferences(
            doc: vscode.TextDocument,
            pos: vscode.Position,
            ctx: vscode.ReferenceContext,
          ): Effect.Effect<vscode.Location[]>;
        },
      ) {
        return acquireDisposable(() =>
          api.registerReferenceProvider(selector, {
            provideReferences(doc, pos, ctx, tok) {
              return runPromise(impl.provideReferences(doc, pos, ctx), {
                signal: signalFromToken(tok),
              });
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerDocumentHighlightProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideDocumentHighlights(
            doc: vscode.TextDocument,
            pos: vscode.Position,
          ): Effect.Effect<vscode.DocumentHighlight[]>;
        },
      ) {
        return acquireDisposable(() =>
          api.registerDocumentHighlightProvider(selector, {
            provideDocumentHighlights(doc, pos, tok) {
              return runPromise(impl.provideDocumentHighlights(doc, pos), {
                signal: signalFromToken(tok),
              });
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerDocumentSymbolProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideDocumentSymbols(
            doc: vscode.TextDocument,
          ): Effect.Effect<vscode.DocumentSymbol[]>;
        },
      ) {
        return acquireDisposable(() =>
          api.registerDocumentSymbolProvider(selector, {
            provideDocumentSymbols(doc, tok) {
              return runPromise(impl.provideDocumentSymbols(doc), {
                signal: signalFromToken(tok),
              });
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerFoldingRangeProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideFoldingRanges(
            doc: vscode.TextDocument,
          ): Effect.Effect<vscode.FoldingRange[]>;
        },
      ) {
        return acquireDisposable(() =>
          api.registerFoldingRangeProvider(selector, {
            provideFoldingRanges(doc, _ctx, tok) {
              return runPromise(impl.provideFoldingRanges(doc), {
                signal: signalFromToken(tok),
              });
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerSelectionRangeProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideSelectionRanges(
            doc: vscode.TextDocument,
            positions: readonly vscode.Position[],
          ): Effect.Effect<vscode.SelectionRange[]>;
        },
      ) {
        return acquireDisposable(() =>
          api.registerSelectionRangeProvider(selector, {
            provideSelectionRanges(doc, positions, tok) {
              return runPromise(impl.provideSelectionRanges(doc, positions), {
                signal: signalFromToken(tok),
              });
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerDocumentFormattingEditProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideDocumentFormattingEdits(
            doc: vscode.TextDocument,
            opts: vscode.FormattingOptions,
          ): Effect.Effect<vscode.TextEdit[]>;
        },
      ) {
        return acquireDisposable(() =>
          api.registerDocumentFormattingEditProvider(selector, {
            provideDocumentFormattingEdits(doc, opts, tok) {
              return runPromise(
                impl.provideDocumentFormattingEdits(doc, opts),
                { signal: signalFromToken(tok) },
              );
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerDocumentRangeFormattingEditProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideDocumentRangeFormattingEdits(
            doc: vscode.TextDocument,
            range: vscode.Range,
            opts: vscode.FormattingOptions,
          ): Effect.Effect<vscode.TextEdit[]>;
        },
      ) {
        return acquireDisposable(() =>
          api.registerDocumentRangeFormattingEditProvider(selector, {
            provideDocumentRangeFormattingEdits(doc, range, opts, tok) {
              return runPromise(
                impl.provideDocumentRangeFormattingEdits(doc, range, opts),
                { signal: signalFromToken(tok) },
              );
            },
          }),
        ).pipe(Effect.asVoid);
      },
      registerSignatureHelpProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideSignatureHelp(
            doc: vscode.TextDocument,
            pos: vscode.Position,
          ): Effect.Effect<vscode.SignatureHelp | undefined>;
        },
        metadata: vscode.SignatureHelpProviderMetadata | string[],
      ) {
        return acquireDisposable(() => {
          if (Array.isArray(metadata)) {
            return api.registerSignatureHelpProvider(
              selector,
              {
                provideSignatureHelp(doc, pos, tok) {
                  return runPromise(impl.provideSignatureHelp(doc, pos), {
                    signal: signalFromToken(tok),
                  });
                },
              },
              ...metadata,
            );
          }
          return api.registerSignatureHelpProvider(
            selector,
            {
              provideSignatureHelp(doc, pos, tok) {
                return runPromise(impl.provideSignatureHelp(doc, pos), {
                  signal: signalFromToken(tok),
                });
              },
            },
            metadata,
          );
        }).pipe(Effect.asVoid);
      },
      registerInlayHintsProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideInlayHints(
            doc: vscode.TextDocument,
            range: vscode.Range,
          ): Effect.Effect<vscode.InlayHint[]>;
          resolveInlayHint?: (
            hint: vscode.InlayHint,
          ) => Effect.Effect<vscode.InlayHint>;
        },
      ) {
        return acquireDisposable(() =>
          api.registerInlayHintsProvider(selector, {
            provideInlayHints(doc, range, tok) {
              return runPromise(impl.provideInlayHints(doc, range), {
                signal: signalFromToken(tok),
              });
            },
            resolveInlayHint: impl.resolveInlayHint
              ? (
                  (resolve) => (hint, tok) =>
                    runPromise(resolve(hint), {
                      signal: signalFromToken(tok),
                    })
                )(impl.resolveInlayHint)
              : undefined,
          }),
        ).pipe(Effect.asVoid);
      },
      registerCompletionItemProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideCompletionItems(
            doc: vscode.TextDocument,
            pos: vscode.Position,
            ctx: vscode.CompletionContext,
          ): Effect.Effect<vscode.CompletionItem[]>;
          resolveCompletionItem?: (
            item: vscode.CompletionItem,
          ) => Effect.Effect<vscode.CompletionItem>;
        },
        triggerCharacters: string[],
      ) {
        return acquireDisposable(() =>
          api.registerCompletionItemProvider(
            selector,
            {
              provideCompletionItems(doc, pos, tok, ctx) {
                return runPromise(impl.provideCompletionItems(doc, pos, ctx), {
                  signal: signalFromToken(tok),
                });
              },
              resolveCompletionItem: impl.resolveCompletionItem
                ? (
                    (resolve) => (item, tok) =>
                      runPromise(resolve(item), {
                        signal: signalFromToken(tok),
                      })
                  )(impl.resolveCompletionItem)
                : undefined,
            },
            ...triggerCharacters,
          ),
        ).pipe(Effect.asVoid);
      },
      registerCodeActionsProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideCodeActions(
            doc: vscode.TextDocument,
            range: vscode.Range,
            ctx: vscode.CodeActionContext,
          ): Effect.Effect<vscode.CodeAction[]>;
          resolveCodeAction?: (
            item: vscode.CodeAction,
          ) => Effect.Effect<vscode.CodeAction>;
        },
        metadata: vscode.CodeActionProviderMetadata | undefined,
      ) {
        return acquireDisposable(() =>
          api.registerCodeActionsProvider(
            selector,
            {
              provideCodeActions(doc, range, ctx, tok) {
                return runPromise(impl.provideCodeActions(doc, range, ctx), {
                  signal: signalFromToken(tok),
                });
              },
              resolveCodeAction: impl.resolveCodeAction
                ? (
                    (resolve) => (item, tok) =>
                      runPromise(resolve(item), {
                        signal: signalFromToken(tok),
                      })
                  )(impl.resolveCodeAction)
                : undefined,
            },
            metadata,
          ),
        ).pipe(Effect.asVoid);
      },
      registerRenameProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideRenameEdits(
            doc: vscode.TextDocument,
            pos: vscode.Position,
            newName: string,
          ): Effect.Effect<vscode.WorkspaceEdit | undefined>;
          prepareRename?: (
            doc: vscode.TextDocument,
            pos: vscode.Position,
          ) => Effect.Effect<
            | vscode.Range
            | { range: vscode.Range; placeholder: string }
            | undefined
          >;
        },
      ) {
        return acquireDisposable(() =>
          api.registerRenameProvider(selector, {
            provideRenameEdits(doc, pos, newName, tok) {
              return runPromise(impl.provideRenameEdits(doc, pos, newName), {
                signal: signalFromToken(tok),
              });
            },
            prepareRename: impl.prepareRename
              ? (
                  (prepare) => (doc, pos, tok) =>
                    runPromise(prepare(doc, pos), {
                      signal: signalFromToken(tok),
                    })
                )(impl.prepareRename)
              : undefined,
          }),
        ).pipe(Effect.asVoid);
      },
      registerDocumentSemanticTokensProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideDocumentSemanticTokens(
            doc: vscode.TextDocument,
          ): Effect.Effect<vscode.SemanticTokens | undefined>;
        },
        legend: vscode.SemanticTokensLegend,
      ) {
        return acquireDisposable(() =>
          api.registerDocumentSemanticTokensProvider(
            selector,
            {
              provideDocumentSemanticTokens(doc, tok) {
                return runPromise(impl.provideDocumentSemanticTokens(doc), {
                  signal: signalFromToken(tok),
                });
              },
            },
            legend,
          ),
        ).pipe(Effect.asVoid);
      },
      registerDocumentRangeSemanticTokensProvider(
        selector: vscode.DocumentSelector,
        impl: {
          provideDocumentRangeSemanticTokens(
            doc: vscode.TextDocument,
            range: vscode.Range,
          ): Effect.Effect<vscode.SemanticTokens | undefined>;
        },
        legend: vscode.SemanticTokensLegend,
      ) {
        return acquireDisposable(() =>
          api.registerDocumentRangeSemanticTokensProvider(
            selector,
            {
              provideDocumentRangeSemanticTokens(doc, range, tok) {
                return runPromise(
                  impl.provideDocumentRangeSemanticTokens(doc, range),
                  { signal: signalFromToken(tok) },
                );
              },
            },
            legend,
          ),
        ).pipe(Effect.asVoid);
      },
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export class ParseUriError extends Data.TaggedError("ParseUriError")<{
  cause: unknown;
}> {}

/**
 * Wraps VS Code API functionality in Effect services
 */
export class VsCode extends Context.Service<VsCode>()("VsCode", {
  make: Effect.gen(function* () {
    // Expose the raw vscode module for runtime inspection via --inspect-extensions.
    // Only active when MARIMO_DEBUG=1 (set by launch-dev.sh).
    if (process.env.MARIMO_DEBUG === "1") {
      // oxlint-disable-next-line eslint/no-underscore-dangle
      globalThis.__marimoVsCode = vscode;
    }

    return {
      // namespaces
      window: yield* Window.Service,
      commands: yield* Commands.Service,
      workspace: yield* Workspace.Service,
      env: yield* Env.Service,
      debug: yield* Debug.Service,
      notebooks: yield* Notebooks,
      auth: yield* Auth,
      languages: yield* Languages,
      Diagnostic: vscode.Diagnostic,
      DiagnosticSeverity: vscode.DiagnosticSeverity,
      CodeActionTriggerKind: vscode.CodeActionTriggerKind,
      Hover: vscode.Hover,
      TextEdit: vscode.TextEdit,
      SignatureHelp: vscode.SignatureHelp,
      InlayHint: vscode.InlayHint,
      InlayHintLabelPart: vscode.InlayHintLabelPart,
      SnippetString: vscode.SnippetString,
      CodeAction: vscode.CodeAction,
      CodeActionKind: vscode.CodeActionKind,
      CompletionTriggerKind: vscode.CompletionTriggerKind,
      CompletionItem: vscode.CompletionItem,
      CompletionItemKind: vscode.CompletionItemKind,
      CompletionList: vscode.CompletionList,
      MarkdownString: vscode.MarkdownString,
      SignatureInformation: vscode.SignatureInformation,
      ParameterInformation: vscode.ParameterInformation,
      CodeLens: vscode.CodeLens,
      DocumentHighlight: vscode.DocumentHighlight,
      DocumentSymbol: vscode.DocumentSymbol,
      FoldingRange: vscode.FoldingRange,
      SelectionRange: vscode.SelectionRange,
      SemanticTokensLegend: vscode.SemanticTokensLegend,
      SemanticTokens: vscode.SemanticTokens,
      LanguageModelToolResult: vscode.LanguageModelToolResult,
      LanguageModelTextPart: vscode.LanguageModelTextPart,
      // data types
      NotebookData: vscode.NotebookData,
      NotebookCellData: vscode.NotebookCellData,
      NotebookCellKind: vscode.NotebookCellKind,
      NotebookCellOutput: vscode.NotebookCellOutput,
      NotebookCellOutputItem: vscode.NotebookCellOutputItem,
      NotebookEditorRevealType: vscode.NotebookEditorRevealType,
      NotebookEdit: vscode.NotebookEdit,
      NotebookRange: vscode.NotebookRange,
      NotebookCellStatusBarItem: vscode.NotebookCellStatusBarItem,
      NotebookControllerAffinity: vscode.NotebookControllerAffinity,
      NotebookCellStatusBarAlignment: vscode.NotebookCellStatusBarAlignment,
      WorkspaceEdit: vscode.WorkspaceEdit,
      Position: vscode.Position,
      EventEmitter: vscode.EventEmitter,
      DebugAdapterInlineImplementation: vscode.DebugAdapterInlineImplementation,
      ProgressLocation: vscode.ProgressLocation,
      ThemeIcon: vscode.ThemeIcon,
      TreeItem: vscode.TreeItem,
      TreeItemCollapsibleState: vscode.TreeItemCollapsibleState,
      ThemeColor: vscode.ThemeColor,
      StatusBarAlignment: vscode.StatusBarAlignment,
      Location: vscode.Location,
      Uri: vscode.Uri,
      Range: vscode.Range,
      RelativePattern: vscode.RelativePattern,
      version: vscode.version,
      extensions: {
        getExtension<T = unknown>(extensionId: string) {
          return Option.fromNullishOr(
            vscode.extensions.getExtension<T>(extensionId),
          );
        },
      },
      // Language Model (agent tools). Inline like `extensions` — one method.
      lm: {
        /**
         * Register a language-model tool; unregistered when the surrounding
         * scope closes. The tool's `invoke`/`prepareInvocation` are built by
         * the caller (which owns the runtime to run any Effects).
         */
        registerTool<T>(name: string, tool: vscode.LanguageModelTool<T>) {
          return Effect.asVoid(
            acquireDisposable(() => vscode.lm.registerTool(name, tool)),
          );
        },
      },
      // helper
      utils: {
        parseUri(value: string) {
          return Result.try({
            try: () => vscode.Uri.parse(value, /* strict*/ true),
            catch: (cause) => new ParseUriError({ cause }),
          });
        },
      },
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([
      Window.layer,
      Workspace.layer,
      Commands.defaultLayer,
      Env.layer,
      Debug.layer,
      Notebooks.layer,
      Auth.layer,
      Languages.layer,
    ]),
  );
}
