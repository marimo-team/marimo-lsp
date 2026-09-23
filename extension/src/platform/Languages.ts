import { Context, Effect, Layer, Scope } from "effect";
// oxlint-disable-next-line marimo/vscode-type-only
import * as vscode from "vscode";

import { acquireDisposable } from "../lib/acquireDisposable.ts";
import { signalFromToken } from "../lib/signalFromToken.ts";

type Registration = Effect.Effect<void, never, Scope.Scope>;

export interface Interface {
  readonly registerCodeLensProvider: (
    selector: vscode.DocumentSelector,
    provider: vscode.CodeLensProvider,
  ) => Registration;
  readonly createDiagnosticCollection: (
    name: string,
  ) => vscode.DiagnosticCollection;
  readonly registerHoverProvider: (
    selector: vscode.DocumentSelector,
    impl: {
      readonly provideHover: (
        doc: vscode.TextDocument,
        pos: vscode.Position,
      ) => Effect.Effect<vscode.Hover | undefined>;
    },
  ) => Registration;
  readonly registerDefinitionProvider: (
    selector: vscode.DocumentSelector,
    impl: {
      readonly provideDefinition: (
        doc: vscode.TextDocument,
        pos: vscode.Position,
      ) => Effect.Effect<
        vscode.Definition | vscode.DefinitionLink[] | undefined
      >;
    },
  ) => Registration;
  readonly registerDeclarationProvider: (
    selector: vscode.DocumentSelector,
    impl: {
      readonly provideDeclaration: (
        doc: vscode.TextDocument,
        pos: vscode.Position,
      ) => Effect.Effect<
        vscode.Declaration | vscode.LocationLink[] | undefined
      >;
    },
  ) => Registration;
  readonly registerTypeDefinitionProvider: (
    selector: vscode.DocumentSelector,
    impl: {
      readonly provideTypeDefinition: (
        doc: vscode.TextDocument,
        pos: vscode.Position,
      ) => Effect.Effect<
        vscode.Definition | vscode.DefinitionLink[] | undefined
      >;
    },
  ) => Registration;
  readonly registerReferenceProvider: (
    selector: vscode.DocumentSelector,
    impl: {
      readonly provideReferences: (
        doc: vscode.TextDocument,
        pos: vscode.Position,
        context: vscode.ReferenceContext,
      ) => Effect.Effect<vscode.Location[]>;
    },
  ) => Registration;
  readonly registerDocumentHighlightProvider: (
    selector: vscode.DocumentSelector,
    impl: {
      readonly provideDocumentHighlights: (
        doc: vscode.TextDocument,
        pos: vscode.Position,
      ) => Effect.Effect<vscode.DocumentHighlight[]>;
    },
  ) => Registration;
  readonly registerDocumentSymbolProvider: (
    selector: vscode.DocumentSelector,
    impl: {
      readonly provideDocumentSymbols: (
        doc: vscode.TextDocument,
      ) => Effect.Effect<vscode.DocumentSymbol[]>;
    },
  ) => Registration;
  readonly registerFoldingRangeProvider: (
    selector: vscode.DocumentSelector,
    impl: {
      readonly provideFoldingRanges: (
        doc: vscode.TextDocument,
      ) => Effect.Effect<vscode.FoldingRange[]>;
    },
  ) => Registration;
  readonly registerSelectionRangeProvider: (
    selector: vscode.DocumentSelector,
    impl: {
      readonly provideSelectionRanges: (
        doc: vscode.TextDocument,
        positions: readonly vscode.Position[],
      ) => Effect.Effect<vscode.SelectionRange[]>;
    },
  ) => Registration;
  readonly registerDocumentFormattingEditProvider: (
    selector: vscode.DocumentSelector,
    impl: {
      readonly provideDocumentFormattingEdits: (
        doc: vscode.TextDocument,
        options: vscode.FormattingOptions,
      ) => Effect.Effect<vscode.TextEdit[]>;
    },
  ) => Registration;
  readonly registerDocumentRangeFormattingEditProvider: (
    selector: vscode.DocumentSelector,
    impl: {
      readonly provideDocumentRangeFormattingEdits: (
        doc: vscode.TextDocument,
        range: vscode.Range,
        options: vscode.FormattingOptions,
      ) => Effect.Effect<vscode.TextEdit[]>;
    },
  ) => Registration;
  readonly registerSignatureHelpProvider: (
    selector: vscode.DocumentSelector,
    impl: {
      readonly provideSignatureHelp: (
        doc: vscode.TextDocument,
        pos: vscode.Position,
      ) => Effect.Effect<vscode.SignatureHelp | undefined>;
    },
    metadata: vscode.SignatureHelpProviderMetadata | string[],
  ) => Registration;
  readonly registerInlayHintsProvider: (
    selector: vscode.DocumentSelector,
    impl: {
      readonly provideInlayHints: (
        doc: vscode.TextDocument,
        range: vscode.Range,
      ) => Effect.Effect<vscode.InlayHint[]>;
      readonly resolveInlayHint?: (
        hint: vscode.InlayHint,
      ) => Effect.Effect<vscode.InlayHint>;
    },
  ) => Registration;
  readonly registerCompletionItemProvider: (
    selector: vscode.DocumentSelector,
    impl: {
      readonly provideCompletionItems: (
        doc: vscode.TextDocument,
        pos: vscode.Position,
        context: vscode.CompletionContext,
      ) => Effect.Effect<vscode.CompletionItem[]>;
      readonly resolveCompletionItem?: (
        item: vscode.CompletionItem,
      ) => Effect.Effect<vscode.CompletionItem>;
    },
    triggerCharacters: string[],
  ) => Registration;
  readonly registerCodeActionsProvider: (
    selector: vscode.DocumentSelector,
    impl: {
      readonly provideCodeActions: (
        doc: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext,
      ) => Effect.Effect<vscode.CodeAction[]>;
      readonly resolveCodeAction?: (
        item: vscode.CodeAction,
      ) => Effect.Effect<vscode.CodeAction>;
    },
    metadata: vscode.CodeActionProviderMetadata | undefined,
  ) => Registration;
  readonly registerRenameProvider: (
    selector: vscode.DocumentSelector,
    impl: {
      readonly provideRenameEdits: (
        doc: vscode.TextDocument,
        pos: vscode.Position,
        newName: string,
      ) => Effect.Effect<vscode.WorkspaceEdit | undefined>;
      readonly prepareRename?: (
        doc: vscode.TextDocument,
        pos: vscode.Position,
      ) => Effect.Effect<
        | vscode.Range
        | { readonly range: vscode.Range; readonly placeholder: string }
        | undefined
      >;
    },
  ) => Registration;
  readonly registerDocumentSemanticTokensProvider: (
    selector: vscode.DocumentSelector,
    impl: {
      readonly provideDocumentSemanticTokens: (
        doc: vscode.TextDocument,
      ) => Effect.Effect<vscode.SemanticTokens | undefined>;
    },
    legend: vscode.SemanticTokensLegend,
  ) => Registration;
  readonly registerDocumentRangeSemanticTokensProvider: (
    selector: vscode.DocumentSelector,
    impl: {
      readonly provideDocumentRangeSemanticTokens: (
        doc: vscode.TextDocument,
        range: vscode.Range,
      ) => Effect.Effect<vscode.SemanticTokens | undefined>;
    },
    legend: vscode.SemanticTokensLegend,
  ) => Registration;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/Languages",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const api = vscode.languages;
    const runPromise = Effect.runPromiseWith(yield* Effect.context());

    const registerCodeLensProvider = Effect.fn(
      "Languages.registerCodeLensProvider",
    )(function* (
      selector: vscode.DocumentSelector,
      provider: vscode.CodeLensProvider,
    ) {
      yield* acquireDisposable(() =>
        api.registerCodeLensProvider(selector, provider),
      );
    });

    const createDiagnosticCollection = (name: string) =>
      api.createDiagnosticCollection(name);

    const registerHoverProvider = Effect.fn("Languages.registerHoverProvider")(
      function* (
        selector: vscode.DocumentSelector,
        impl: Parameters<Interface["registerHoverProvider"]>[1],
      ) {
        yield* acquireDisposable(() =>
          api.registerHoverProvider(selector, {
            provideHover: (doc, pos, token) =>
              runPromise(impl.provideHover(doc, pos), {
                signal: signalFromToken(token),
              }),
          }),
        );
      },
    );

    const registerDefinitionProvider = Effect.fn(
      "Languages.registerDefinitionProvider",
    )(function* (
      selector: vscode.DocumentSelector,
      impl: Parameters<Interface["registerDefinitionProvider"]>[1],
    ) {
      yield* acquireDisposable(() =>
        api.registerDefinitionProvider(selector, {
          provideDefinition: (doc, pos, token) =>
            runPromise(impl.provideDefinition(doc, pos), {
              signal: signalFromToken(token),
            }),
        }),
      );
    });

    const registerDeclarationProvider = Effect.fn(
      "Languages.registerDeclarationProvider",
    )(function* (
      selector: vscode.DocumentSelector,
      impl: Parameters<Interface["registerDeclarationProvider"]>[1],
    ) {
      yield* acquireDisposable(() =>
        api.registerDeclarationProvider(selector, {
          provideDeclaration: (doc, pos, token) =>
            runPromise(impl.provideDeclaration(doc, pos), {
              signal: signalFromToken(token),
            }),
        }),
      );
    });

    const registerTypeDefinitionProvider = Effect.fn(
      "Languages.registerTypeDefinitionProvider",
    )(function* (
      selector: vscode.DocumentSelector,
      impl: Parameters<Interface["registerTypeDefinitionProvider"]>[1],
    ) {
      yield* acquireDisposable(() =>
        api.registerTypeDefinitionProvider(selector, {
          provideTypeDefinition: (doc, pos, token) =>
            runPromise(impl.provideTypeDefinition(doc, pos), {
              signal: signalFromToken(token),
            }),
        }),
      );
    });

    const registerReferenceProvider = Effect.fn(
      "Languages.registerReferenceProvider",
    )(function* (
      selector: vscode.DocumentSelector,
      impl: Parameters<Interface["registerReferenceProvider"]>[1],
    ) {
      yield* acquireDisposable(() =>
        api.registerReferenceProvider(selector, {
          provideReferences: (doc, pos, context, token) =>
            runPromise(impl.provideReferences(doc, pos, context), {
              signal: signalFromToken(token),
            }),
        }),
      );
    });

    const registerDocumentHighlightProvider = Effect.fn(
      "Languages.registerDocumentHighlightProvider",
    )(function* (
      selector: vscode.DocumentSelector,
      impl: Parameters<Interface["registerDocumentHighlightProvider"]>[1],
    ) {
      yield* acquireDisposable(() =>
        api.registerDocumentHighlightProvider(selector, {
          provideDocumentHighlights: (doc, pos, token) =>
            runPromise(impl.provideDocumentHighlights(doc, pos), {
              signal: signalFromToken(token),
            }),
        }),
      );
    });

    const registerDocumentSymbolProvider = Effect.fn(
      "Languages.registerDocumentSymbolProvider",
    )(function* (
      selector: vscode.DocumentSelector,
      impl: Parameters<Interface["registerDocumentSymbolProvider"]>[1],
    ) {
      yield* acquireDisposable(() =>
        api.registerDocumentSymbolProvider(selector, {
          provideDocumentSymbols: (doc, token) =>
            runPromise(impl.provideDocumentSymbols(doc), {
              signal: signalFromToken(token),
            }),
        }),
      );
    });

    const registerFoldingRangeProvider = Effect.fn(
      "Languages.registerFoldingRangeProvider",
    )(function* (
      selector: vscode.DocumentSelector,
      impl: Parameters<Interface["registerFoldingRangeProvider"]>[1],
    ) {
      yield* acquireDisposable(() =>
        api.registerFoldingRangeProvider(selector, {
          provideFoldingRanges: (doc, _context, token) =>
            runPromise(impl.provideFoldingRanges(doc), {
              signal: signalFromToken(token),
            }),
        }),
      );
    });

    const registerSelectionRangeProvider = Effect.fn(
      "Languages.registerSelectionRangeProvider",
    )(function* (
      selector: vscode.DocumentSelector,
      impl: Parameters<Interface["registerSelectionRangeProvider"]>[1],
    ) {
      yield* acquireDisposable(() =>
        api.registerSelectionRangeProvider(selector, {
          provideSelectionRanges: (doc, positions, token) =>
            runPromise(impl.provideSelectionRanges(doc, positions), {
              signal: signalFromToken(token),
            }),
        }),
      );
    });

    const registerDocumentFormattingEditProvider = Effect.fn(
      "Languages.registerDocumentFormattingEditProvider",
    )(function* (
      selector: vscode.DocumentSelector,
      impl: Parameters<Interface["registerDocumentFormattingEditProvider"]>[1],
    ) {
      yield* acquireDisposable(() =>
        api.registerDocumentFormattingEditProvider(selector, {
          provideDocumentFormattingEdits: (doc, options, token) =>
            runPromise(impl.provideDocumentFormattingEdits(doc, options), {
              signal: signalFromToken(token),
            }),
        }),
      );
    });

    const registerDocumentRangeFormattingEditProvider = Effect.fn(
      "Languages.registerDocumentRangeFormattingEditProvider",
    )(function* (
      selector: vscode.DocumentSelector,
      impl: Parameters<
        Interface["registerDocumentRangeFormattingEditProvider"]
      >[1],
    ) {
      yield* acquireDisposable(() =>
        api.registerDocumentRangeFormattingEditProvider(selector, {
          provideDocumentRangeFormattingEdits: (doc, range, options, token) =>
            runPromise(
              impl.provideDocumentRangeFormattingEdits(doc, range, options),
              { signal: signalFromToken(token) },
            ),
        }),
      );
    });

    const registerSignatureHelpProvider = Effect.fn(
      "Languages.registerSignatureHelpProvider",
    )(function* (
      selector: vscode.DocumentSelector,
      impl: Parameters<Interface["registerSignatureHelpProvider"]>[1],
      metadata: vscode.SignatureHelpProviderMetadata | string[],
    ) {
      yield* acquireDisposable(() => {
        const provider = {
          provideSignatureHelp: (
            doc: vscode.TextDocument,
            pos: vscode.Position,
            token: vscode.CancellationToken,
          ) =>
            runPromise(impl.provideSignatureHelp(doc, pos), {
              signal: signalFromToken(token),
            }),
        };
        return Array.isArray(metadata)
          ? api.registerSignatureHelpProvider(selector, provider, ...metadata)
          : api.registerSignatureHelpProvider(selector, provider, metadata);
      });
    });

    const registerInlayHintsProvider = Effect.fn(
      "Languages.registerInlayHintsProvider",
    )(function* (
      selector: vscode.DocumentSelector,
      impl: Parameters<Interface["registerInlayHintsProvider"]>[1],
    ) {
      const resolveInlayHint = impl.resolveInlayHint;
      yield* acquireDisposable(() =>
        api.registerInlayHintsProvider(selector, {
          provideInlayHints: (doc, range, token) =>
            runPromise(impl.provideInlayHints(doc, range), {
              signal: signalFromToken(token),
            }),
          resolveInlayHint: resolveInlayHint
            ? (hint, token) =>
                runPromise(resolveInlayHint(hint), {
                  signal: signalFromToken(token),
                })
            : undefined,
        }),
      );
    });

    const registerCompletionItemProvider = Effect.fn(
      "Languages.registerCompletionItemProvider",
    )(function* (
      selector: vscode.DocumentSelector,
      impl: Parameters<Interface["registerCompletionItemProvider"]>[1],
      triggerCharacters: string[],
    ) {
      const resolveCompletionItem = impl.resolveCompletionItem;
      yield* acquireDisposable(() =>
        api.registerCompletionItemProvider(
          selector,
          {
            provideCompletionItems: (doc, pos, token, context) =>
              runPromise(impl.provideCompletionItems(doc, pos, context), {
                signal: signalFromToken(token),
              }),
            resolveCompletionItem: resolveCompletionItem
              ? (item, token) =>
                  runPromise(resolveCompletionItem(item), {
                    signal: signalFromToken(token),
                  })
              : undefined,
          },
          ...triggerCharacters,
        ),
      );
    });

    const registerCodeActionsProvider = Effect.fn(
      "Languages.registerCodeActionsProvider",
    )(function* (
      selector: vscode.DocumentSelector,
      impl: Parameters<Interface["registerCodeActionsProvider"]>[1],
      metadata: vscode.CodeActionProviderMetadata | undefined,
    ) {
      const resolveCodeAction = impl.resolveCodeAction;
      yield* acquireDisposable(() =>
        api.registerCodeActionsProvider(
          selector,
          {
            provideCodeActions: (doc, range, context, token) =>
              runPromise(impl.provideCodeActions(doc, range, context), {
                signal: signalFromToken(token),
              }),
            resolveCodeAction: resolveCodeAction
              ? (item, token) =>
                  runPromise(resolveCodeAction(item), {
                    signal: signalFromToken(token),
                  })
              : undefined,
          },
          metadata,
        ),
      );
    });

    const registerRenameProvider = Effect.fn(
      "Languages.registerRenameProvider",
    )(function* (
      selector: vscode.DocumentSelector,
      impl: Parameters<Interface["registerRenameProvider"]>[1],
    ) {
      const prepareRename = impl.prepareRename;
      yield* acquireDisposable(() =>
        api.registerRenameProvider(selector, {
          provideRenameEdits: (doc, pos, newName, token) =>
            runPromise(impl.provideRenameEdits(doc, pos, newName), {
              signal: signalFromToken(token),
            }),
          prepareRename: prepareRename
            ? (doc, pos, token) =>
                runPromise(prepareRename(doc, pos), {
                  signal: signalFromToken(token),
                })
            : undefined,
        }),
      );
    });

    const registerDocumentSemanticTokensProvider = Effect.fn(
      "Languages.registerDocumentSemanticTokensProvider",
    )(function* (
      selector: vscode.DocumentSelector,
      impl: Parameters<Interface["registerDocumentSemanticTokensProvider"]>[1],
      legend: vscode.SemanticTokensLegend,
    ) {
      yield* acquireDisposable(() =>
        api.registerDocumentSemanticTokensProvider(
          selector,
          {
            provideDocumentSemanticTokens: (doc, token) =>
              runPromise(impl.provideDocumentSemanticTokens(doc), {
                signal: signalFromToken(token),
              }),
          },
          legend,
        ),
      );
    });

    const registerDocumentRangeSemanticTokensProvider = Effect.fn(
      "Languages.registerDocumentRangeSemanticTokensProvider",
    )(function* (
      selector: vscode.DocumentSelector,
      impl: Parameters<
        Interface["registerDocumentRangeSemanticTokensProvider"]
      >[1],
      legend: vscode.SemanticTokensLegend,
    ) {
      yield* acquireDisposable(() =>
        api.registerDocumentRangeSemanticTokensProvider(
          selector,
          {
            provideDocumentRangeSemanticTokens: (doc, range, token) =>
              runPromise(impl.provideDocumentRangeSemanticTokens(doc, range), {
                signal: signalFromToken(token),
              }),
          },
          legend,
        ),
      );
    });

    return Service.of({
      registerCodeLensProvider,
      createDiagnosticCollection,
      registerHoverProvider,
      registerDefinitionProvider,
      registerDeclarationProvider,
      registerTypeDefinitionProvider,
      registerReferenceProvider,
      registerDocumentHighlightProvider,
      registerDocumentSymbolProvider,
      registerFoldingRangeProvider,
      registerSelectionRangeProvider,
      registerDocumentFormattingEditProvider,
      registerDocumentRangeFormattingEditProvider,
      registerSignatureHelpProvider,
      registerInlayHintsProvider,
      registerCompletionItemProvider,
      registerCodeActionsProvider,
      registerRenameProvider,
      registerDocumentSemanticTokensProvider,
      registerDocumentRangeSemanticTokensProvider,
    });
  }),
);
