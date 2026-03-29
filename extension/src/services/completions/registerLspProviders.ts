/**
 * Registers VS Code language feature providers for a {@link NotebookLspClient},
 * driven by the server's advertised capabilities.
 *
 * Each provider converts VS Code types → LSP types, calls the client's typed
 * `sendRequest` method, then converts the response back. Only providers for
 * capabilities the server actually advertises are registered.
 *
 * This file imports `vscode` directly (not through the VsCode service) to
 * avoid bloating the service wrapper and test mock with 18+ registration
 * methods that are only used here.
 */

import { Effect } from "effect";
// oxlint-disable-next-line marimo/vscode-type-only
import * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import { LanguageId } from "../../constants.ts";
import { acquireDisposable } from "../../utils/acquireDisposable.ts";
import type { NotebookLspClient } from "./NotebookLspClient.ts";

// ---------------------------------------------------------------------------
// Conversion helpers: vscode ↔ LSP
// ---------------------------------------------------------------------------

function toLspPosition(pos: vscode.Position): lsp.Position {
  return { line: pos.line, character: pos.character };
}

function toLspRange(range: vscode.Range): lsp.Range {
  return { start: toLspPosition(range.start), end: toLspPosition(range.end) };
}

function toVscodeRange(range: lsp.Range): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

function toVscodeLocation(loc: lsp.Location): vscode.Location {
  return new vscode.Location(
    vscode.Uri.parse(loc.uri),
    toVscodeRange(loc.range),
  );
}

function toDocId(doc: vscode.TextDocument): lsp.TextDocumentIdentifier {
  return { uri: doc.uri.toString() };
}

function toDocPos(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): lsp.TextDocumentPositionParams {
  return { textDocument: toDocId(doc), position: toLspPosition(pos) };
}

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

/**
 * Register VS Code providers for all capabilities the server advertises.
 * Returns a scoped effect — all registrations are cleaned up on scope close.
 */
export const registerLspProviders = Effect.fn("registerLspProviders")(
  function* (client: NotebookLspClient) {
    const caps = client.serverInfo.capabilities;
    const sel: vscode.DocumentSelector = [
      { scheme: "vscode-notebook-cell", language: LanguageId.Python },
    ];

    if (caps.hoverProvider) {
      yield* acquireDisposable(() =>
        vscode.languages.registerHoverProvider(sel, {
          async provideHover(doc, pos) {
            const r = await Effect.runPromise(
              client.sendRequest(lsp.HoverRequest.method, toDocPos(doc, pos)),
            );
            if (!r) return undefined;
            return new vscode.Hover(
              toMarkdown(r.contents),
              r.range ? toVscodeRange(r.range) : undefined,
            );
          },
        }),
      );
    }

    if (caps.completionProvider) {
      yield* acquireDisposable(() =>
        vscode.languages.registerCompletionItemProvider(
          sel,
          {
            async provideCompletionItems(doc, pos, _tok, ctx) {
              const r = await Effect.runPromise(
                client.sendRequest(lsp.CompletionRequest.method, {
                  textDocument: toDocId(doc),
                  position: toLspPosition(pos),
                  context: {
                    triggerKind: (ctx.triggerKind +
                      1) as lsp.CompletionTriggerKind,
                    triggerCharacter: ctx.triggerCharacter,
                  },
                }),
              );
              if (!r) return undefined;
              const items = Array.isArray(r) ? r : r.items;
              return items.map(toCompletionItem);
            },
          },
          ...(caps.completionProvider?.triggerCharacters ?? []),
        ),
      );
    }

    if (caps.definitionProvider) {
      yield* acquireDisposable(() =>
        vscode.languages.registerDefinitionProvider(sel, {
          async provideDefinition(doc, pos) {
            const r = await Effect.runPromise(
              client.sendRequest(
                lsp.DefinitionRequest.method,
                toDocPos(doc, pos),
              ),
            );
            return toLocationResult(r);
          },
        }),
      );
    }

    if (caps.typeDefinitionProvider) {
      yield* acquireDisposable(() =>
        vscode.languages.registerTypeDefinitionProvider(sel, {
          async provideTypeDefinition(doc, pos) {
            const r = await Effect.runPromise(
              client.sendRequest(
                lsp.TypeDefinitionRequest.method,
                toDocPos(doc, pos),
              ),
            );
            return toLocationResult(r);
          },
        }),
      );
    }

    if (caps.declarationProvider) {
      yield* acquireDisposable(() =>
        vscode.languages.registerDeclarationProvider(sel, {
          async provideDeclaration(doc, pos) {
            const r = await Effect.runPromise(
              client.sendRequest(
                lsp.DeclarationRequest.method,
                toDocPos(doc, pos),
              ),
            );
            return toLocationResult(r);
          },
        }),
      );
    }

    if (caps.referencesProvider) {
      yield* acquireDisposable(() =>
        vscode.languages.registerReferenceProvider(sel, {
          async provideReferences(doc, pos, ctx) {
            const r = await Effect.runPromise(
              client.sendRequest(lsp.ReferencesRequest.method, {
                ...toDocPos(doc, pos),
                context: ctx,
              }),
            );
            return r?.map(toVscodeLocation) ?? [];
          },
        }),
      );
    }

    if (caps.renameProvider) {
      const provider: vscode.RenameProvider = {
        async provideRenameEdits(doc, pos, newName) {
          const r = await Effect.runPromise(
            client.sendRequest(lsp.RenameRequest.method, {
              ...toDocPos(doc, pos),
              newName,
            }),
          );
          return r ? toWorkspaceEdit(r) : undefined;
        },
      };
      if (
        typeof caps.renameProvider === "object" &&
        caps.renameProvider.prepareProvider
      ) {
        provider.prepareRename = async (doc, pos) => {
          const r = await Effect.runPromise(
            client.sendRequest(
              lsp.PrepareRenameRequest.method,
              toDocPos(doc, pos),
            ),
          );
          return r && "start" in r ? toVscodeRange(r) : undefined;
        };
      }
      yield* acquireDisposable(() =>
        vscode.languages.registerRenameProvider(sel, provider),
      );
    }

    if (caps.signatureHelpProvider) {
      yield* acquireDisposable(() =>
        vscode.languages.registerSignatureHelpProvider(
          sel,
          {
            async provideSignatureHelp(doc, pos) {
              const r = await Effect.runPromise(
                client.sendRequest(lsp.SignatureHelpRequest.method, {
                  ...toDocPos(doc, pos),
                  context: {
                    triggerKind: 1 as lsp.SignatureHelpTriggerKind,
                    isRetrigger: false,
                  },
                }),
              );
              if (!r) return undefined;
              return {
                signatures: r.signatures.map((sig) => {
                  const info = new vscode.SignatureInformation(
                    sig.label,
                    toMarkdownOrUndefined(sig.documentation),
                  );
                  info.parameters = (sig.parameters ?? []).map(
                    (p) =>
                      new vscode.ParameterInformation(
                        p.label,
                        toMarkdownOrUndefined(p.documentation),
                      ),
                  );
                  return info;
                }),
                activeSignature: r.activeSignature ?? 0,
                activeParameter: r.activeParameter ?? 0,
              };
            },
          },
          ...(caps.signatureHelpProvider?.triggerCharacters ?? []),
          ...(caps.signatureHelpProvider?.retriggerCharacters ?? []),
        ),
      );
    }

    if (caps.documentHighlightProvider) {
      yield* acquireDisposable(() =>
        vscode.languages.registerDocumentHighlightProvider(sel, {
          async provideDocumentHighlights(doc, pos) {
            const r = await Effect.runPromise(
              client.sendRequest(
                lsp.DocumentHighlightRequest.method,
                toDocPos(doc, pos),
              ),
            );
            return r?.map(
              (h) =>
                new vscode.DocumentHighlight(
                  toVscodeRange(h.range),
                  h.kind as unknown as vscode.DocumentHighlightKind,
                ),
            );
          },
        }),
      );
    }

    if (caps.documentSymbolProvider) {
      yield* acquireDisposable(() =>
        vscode.languages.registerDocumentSymbolProvider(sel, {
          async provideDocumentSymbols(doc) {
            const r = await Effect.runPromise(
              client.sendRequest(lsp.DocumentSymbolRequest.method, {
                textDocument: toDocId(doc),
              }),
            );
            if (!r) return [];
            return r.map(
              (sym) =>
                new vscode.DocumentSymbol(
                  sym.name,
                  sym.detail ?? "",
                  sym.kind - 1,
                  toVscodeRange(sym.range),
                  toVscodeRange(sym.selectionRange),
                ),
            );
          },
        }),
      );
    }

    if (caps.documentFormattingProvider) {
      yield* acquireDisposable(() =>
        vscode.languages.registerDocumentFormattingEditProvider(sel, {
          async provideDocumentFormattingEdits(doc, opts) {
            const r = await Effect.runPromise(
              client.sendRequest(lsp.DocumentFormattingRequest.method, {
                textDocument: toDocId(doc),
                options: {
                  tabSize: opts.tabSize,
                  insertSpaces: opts.insertSpaces,
                },
              }),
            );
            return r?.map(
              (e) => new vscode.TextEdit(toVscodeRange(e.range), e.newText),
            );
          },
        }),
      );
    }

    if (caps.documentRangeFormattingProvider) {
      yield* acquireDisposable(() =>
        vscode.languages.registerDocumentRangeFormattingEditProvider(sel, {
          async provideDocumentRangeFormattingEdits(doc, range, opts) {
            const r = await Effect.runPromise(
              client.sendRequest(lsp.DocumentRangeFormattingRequest.method, {
                textDocument: toDocId(doc),
                range: toLspRange(range),
                options: {
                  tabSize: opts.tabSize,
                  insertSpaces: opts.insertSpaces,
                },
              }),
            );
            return r?.map(
              (e) => new vscode.TextEdit(toVscodeRange(e.range), e.newText),
            );
          },
        }),
      );
    }

    if (caps.codeActionProvider) {
      yield* acquireDisposable(() =>
        vscode.languages.registerCodeActionsProvider(sel, {
          async provideCodeActions(doc, range, ctx) {
            const r = await Effect.runPromise(
              client.sendRequest(lsp.CodeActionRequest.method, {
                textDocument: toDocId(doc),
                range: toLspRange(range),
                context: {
                  diagnostics: ctx.diagnostics.map(
                    (d) =>
                      ({
                        range: toLspRange(d.range),
                        message: d.message,
                        severity:
                          d.severity != null
                            ? ((d.severity + 1) as lsp.DiagnosticSeverity)
                            : undefined,
                        code:
                          typeof d.code === "object" && d.code != null
                            ? d.code.value
                            : d.code,
                        source: d.source,
                      }) satisfies lsp.Diagnostic,
                  ),
                  only: ctx.only
                    ? (ctx.only as unknown as vscode.CodeActionKind[]).map(
                        (k) => k.value,
                      )
                    : undefined,
                },
              }),
            );
            if (!r) return [];
            return r
              .filter((a): a is lsp.CodeAction => "title" in a)
              .map((a) => {
                const ca = new vscode.CodeAction(
                  a.title,
                  a.kind
                    ? (a.kind as unknown as vscode.CodeActionKind)
                    : undefined,
                );
                if (a.edit) ca.edit = toWorkspaceEdit(a.edit);
                if (a.isPreferred) ca.isPreferred = a.isPreferred;
                if (a.command)
                  ca.command = {
                    title: a.command.title,
                    command: a.command.command,
                    arguments: a.command.arguments,
                  };
                return ca;
              });
          },
        }),
      );
    }

    if (caps.inlayHintProvider) {
      yield* acquireDisposable(() =>
        vscode.languages.registerInlayHintsProvider(sel, {
          async provideInlayHints(doc, range) {
            const r = await Effect.runPromise(
              client.sendRequest(lsp.InlayHintRequest.method, {
                textDocument: toDocId(doc),
                range: toLspRange(range),
              }),
            );
            if (!r) return [];
            return r.map((h) => {
              const label =
                typeof h.label === "string"
                  ? h.label
                  : h.label.map((p) => p.value).join("");
              const hint = new vscode.InlayHint(
                new vscode.Position(h.position.line, h.position.character),
                label,
                h.kind as number | undefined,
              );
              if (h.paddingLeft) hint.paddingLeft = h.paddingLeft;
              if (h.paddingRight) hint.paddingRight = h.paddingRight;
              return hint;
            });
          },
        }),
      );
    }

    if (caps.semanticTokensProvider) {
      const legend = new vscode.SemanticTokensLegend(
        caps.semanticTokensProvider.legend.tokenTypes,
        caps.semanticTokensProvider.legend.tokenModifiers,
      );
      if (caps.semanticTokensProvider.full) {
        yield* acquireDisposable(() =>
          vscode.languages.registerDocumentSemanticTokensProvider(
            sel,
            {
              async provideDocumentSemanticTokens(doc) {
                const r = await Effect.runPromise(
                  client.sendRequest(lsp.SemanticTokensRequest.method, {
                    textDocument: toDocId(doc),
                  }),
                );
                return r
                  ? new vscode.SemanticTokens(
                      new Uint32Array(r.data),
                      r.resultId,
                    )
                  : undefined;
              },
            },
            legend,
          ),
        );
      }
      if (caps.semanticTokensProvider.range) {
        yield* acquireDisposable(() =>
          vscode.languages.registerDocumentRangeSemanticTokensProvider(
            sel,
            {
              async provideDocumentRangeSemanticTokens(doc, range) {
                const r = await Effect.runPromise(
                  client.sendRequest(lsp.SemanticTokensRangeRequest.method, {
                    textDocument: toDocId(doc),
                    range: toLspRange(range),
                  }),
                );
                return r
                  ? new vscode.SemanticTokens(
                      new Uint32Array(r.data),
                      r.resultId,
                    )
                  : undefined;
              },
            },
            legend,
          ),
        );
      }
    }

    if (caps.foldingRangeProvider) {
      yield* acquireDisposable(() =>
        vscode.languages.registerFoldingRangeProvider(sel, {
          async provideFoldingRanges(doc) {
            const r = await Effect.runPromise(
              client.sendRequest(lsp.FoldingRangeRequest.method, {
                textDocument: toDocId(doc),
              }),
            );
            return (
              r?.map(
                (f) =>
                  new vscode.FoldingRange(
                    f.startLine,
                    f.endLine,
                    f.kind as number | undefined,
                  ),
              ) ?? []
            );
          },
        }),
      );
    }

    if (caps.selectionRangeProvider) {
      yield* acquireDisposable(() =>
        vscode.languages.registerSelectionRangeProvider(sel, {
          async provideSelectionRanges(doc, positions) {
            const r = await Effect.runPromise(
              client.sendRequest(lsp.SelectionRangeRequest.method, {
                textDocument: toDocId(doc),
                positions: positions.map(toLspPosition),
              }),
            );
            return r?.map(toSelectionRange) ?? [];
          },
        }),
      );
    }
  },
);

// ---------------------------------------------------------------------------
// Result converters
// ---------------------------------------------------------------------------

function toMarkdown(contents: lsp.Hover["contents"]): vscode.MarkdownString {
  if (typeof contents === "string") return new vscode.MarkdownString(contents);
  if ("kind" in contents) return new vscode.MarkdownString(contents.value);
  if (Array.isArray(contents)) {
    return new vscode.MarkdownString(
      contents.map((c) => (typeof c === "string" ? c : c.value)).join("\n\n"),
    );
  }
  return new vscode.MarkdownString(contents.value);
}

function toMarkdownOrUndefined(
  doc: string | lsp.MarkupContent | undefined,
): string | vscode.MarkdownString | undefined {
  if (!doc) return undefined;
  if (typeof doc === "string") return doc;
  return new vscode.MarkdownString(doc.value);
}

function toCompletionItem(item: lsp.CompletionItem): vscode.CompletionItem {
  const ci = new vscode.CompletionItem(item.label);
  if (item.kind != null) ci.kind = item.kind - 1;
  if (item.detail) ci.detail = item.detail;
  if (item.documentation)
    ci.documentation = toMarkdownOrUndefined(item.documentation);
  if (item.insertText) ci.insertText = item.insertText;
  if (item.filterText) ci.filterText = item.filterText;
  if (item.sortText) ci.sortText = item.sortText;
  return ci;
}

function toLocationResult(
  r: lsp.Definition | lsp.Declaration | null | undefined,
): vscode.Location | vscode.Location[] | undefined {
  if (!r) return undefined;
  if (Array.isArray(r)) {
    return r.map((item) => toVscodeLocation(item));
  }
  return "uri" in r ? toVscodeLocation(r) : undefined;
}

function toWorkspaceEdit(edit: lsp.WorkspaceEdit): vscode.WorkspaceEdit {
  const ws = new vscode.WorkspaceEdit();
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      ws.set(
        vscode.Uri.parse(uri),
        edits.map(
          (e) => new vscode.TextEdit(toVscodeRange(e.range), e.newText),
        ),
      );
    }
  }
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change) {
        ws.set(
          vscode.Uri.parse(change.textDocument.uri),
          change.edits
            .filter((e): e is lsp.TextEdit => "range" in e)
            .map((e) => new vscode.TextEdit(toVscodeRange(e.range), e.newText)),
        );
      }
    }
  }
  return ws;
}

function toSelectionRange(sr: lsp.SelectionRange): vscode.SelectionRange {
  return new vscode.SelectionRange(
    toVscodeRange(sr.range),
    sr.parent ? toSelectionRange(sr.parent) : undefined,
  );
}
