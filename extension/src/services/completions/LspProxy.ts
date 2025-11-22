import { Effect, Option } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageclient/node";
import { VsCode } from "../VsCode.ts";
import { PythonLanguageServer } from "./PythonLanguageServer.ts";
import { VirtualDocumentProvider } from "./VirtualDocumentProvider.ts";

export class LspProxy extends Effect.Service<LspProxy>()("LspProxy", {
  dependencies: [VirtualDocumentProvider.Default, PythonLanguageServer.Default],
  scoped: Effect.gen(function* () {
    const code = yield* VsCode;
    const virtualDocs = yield* VirtualDocumentProvider;
    const pythonLs = yield* PythonLanguageServer;

    function findNotebookCellPair(document: vscode.TextDocument) {
      return Effect.gen(function* () {
        const maybeNotebook = yield* findNotebook(document, { code });
        if (Option.isNone(maybeNotebook)) {
          return Option.none();
        }

        const maybeCell = findCell(maybeNotebook.value, document);
        if (Option.isNone(maybeCell)) {
          return Option.none();
        }
        return Option.some({
          notebook: maybeNotebook.value,
          cell: maybeCell.value,
        });
      });
    }

    return {
      provideCompletionItems: (
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.CompletionContext,
      ) =>
        Effect.gen(function* () {
          const pair = yield* findNotebookCellPair(document);
          if (Option.isNone(pair)) {
            return null;
          }

          const { notebook, cell } = pair.value;
          const info = yield* virtualDocs.getVirtualDocument(notebook);
          const mapper = yield* virtualDocs.getMapperForCell(cell);

          const virtualPosition = mapper.toVirtual(position);

          // Query completions from Python language server
          const completions = yield* pythonLs.getCompletions(
            info.uri,
            {
              line: virtualPosition.line,
              character: virtualPosition.character,
            },
            codeCompletionContextToLsp(context),
          );

          if (!completions?.items) {
            return null;
          }

          // Clone completion items and map ranges back to cell coordinates
          const items = completions.items.map((lspItem) =>
            lspCompletionItemToVscode(lspItem, { code, mapper }),
          );

          return new code.CompletionList(items, completions.isIncomplete);
        }),

      provideHover: (
        document: vscode.TextDocument,
        position: vscode.Position,
      ) =>
        Effect.gen(function* () {
          const pair = yield* findNotebookCellPair(document);

          if (Option.isNone(pair)) {
            return null;
          }

          const { notebook, cell } = pair.value;
          const mapper = yield* virtualDocs.getMapperForCell(cell);
          const info = yield* virtualDocs.getVirtualDocument(notebook);

          const virtualPosition = mapper.toVirtual(position);
          const hover = yield* pythonLs.getHover(info.uri, {
            line: virtualPosition.line,
            character: virtualPosition.character,
          });

          if (!hover) {
            return null;
          }

          return lspHoverToVscode(hover, { code, mapper });
        }),

      provideDefinition: (
        document: vscode.TextDocument,
        position: vscode.Position,
      ) =>
        Effect.gen(function* () {
          const pair = yield* findNotebookCellPair(document);
          if (Option.isNone(pair)) {
            return null;
          }

          const { notebook, cell } = pair.value;
          const mapper = yield* virtualDocs.getMapperForCell(cell);
          const info = yield* virtualDocs.getVirtualDocument(notebook);

          // Map cell position to virtual document position
          const virtualPosition = mapper.toVirtual(position);

          // Query definition from Python language server
          const definitions = yield* pythonLs.getDefinition(info.uri, {
            line: virtualPosition.line,
            character: virtualPosition.character,
          });

          if (!definitions || definitions.length === 0) {
            return null;
          }

          // Map definition locations back to cell coordinates
          const mappedDefinitions: vscode.Location[] = [];

          for (const def of definitions) {
            // LSP can return either Location or LocationLink
            // Location has: { uri, range }
            // LocationLink has: { targetUri, targetRange, targetSelectionRange, originSelectionRange? }
            const isLocationLink = "targetUri" in def;
            const defUri: string = isLocationLink ? def.targetUri : def.uri;
            const defRange: lsp.Range = isLocationLink
              ? def.targetRange
              : def.range;

            // Check if definition is in the virtual document
            if (defUri === info.uri.toString()) {
              // Find which cell contains this definition line
              const defCell = yield* virtualDocs.findCellForVirtualLine(
                notebook,
                defRange.start.line,
              );

              if (Option.isNone(defCell)) {
                // Cell not found, skip this definition
                continue;
              }

              // Get the mapper for the cell containing the definition
              const defMapper = yield* virtualDocs.getMapperForCell(
                defCell.value,
              );

              // Map back to cell position using the correct cell's mapper
              const cellPosition = defMapper.fromVirtual(
                new code.Position(
                  defRange.start.line,
                  defRange.start.character,
                ),
              );

              mappedDefinitions.push(
                new code.Location(
                  defCell.value.document.uri,
                  new code.Position(cellPosition.line, cellPosition.character),
                ),
              );
            } else {
              // Definition is in another file, convert LSP Location to VS Code Location
              const uri = yield* code.utils.parseUri(defUri);

              mappedDefinitions.push(
                new code.Location(
                  uri,
                  new code.Range(
                    new code.Position(
                      defRange.start.line,
                      defRange.start.character,
                    ),
                    new code.Position(
                      defRange.end.line,
                      defRange.end.character,
                    ),
                  ),
                ),
              );
            }
          }

          return mappedDefinitions;
        }),

      provideSignatureHelp: (
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.SignatureHelpContext,
      ) =>
        Effect.gen(function* () {
          const pair = yield* findNotebookCellPair(document);

          if (Option.isNone(pair)) {
            return null;
          }

          const { notebook, cell } = pair.value;
          const mapper = yield* virtualDocs.getMapperForCell(cell);
          const info = yield* virtualDocs.getVirtualDocument(notebook);

          const virtualPosition = mapper.toVirtual(position);

          // Query signature help from Python language server
          const signatureHelp = yield* pythonLs.getSignatureHelp(
            info.uri,
            {
              line: virtualPosition.line,
              character: virtualPosition.character,
            },
            codeSignatureHelpContextToLsp(context),
          );

          if (!signatureHelp) {
            return null;
          }

          return lspSignatureHelpToVscode(signatureHelp, { code });
        }),
    };
  }),
}) {}

/**
 * Find the notebook that contains this document
 */
function findNotebook(
  document: vscode.TextDocument,
  options: { code: VsCode },
): Effect.Effect<Option.Option<vscode.NotebookDocument>> {
  return options.code.workspace.getNotebookDocuments().pipe(
    Effect.map((notebooks) =>
      notebooks.find(
        (nb) =>
          // Match by path
          nb.uri.path === document.uri.path &&
          // Also by authority (for remote workspaces)
          nb.uri.authority === document.uri.authority,
      ),
    ),
    Effect.map(Option.fromNullable),
  );
}

/**
 * Find the cell in a notebook that matches this document
 */
function findCell(
  notebook: vscode.NotebookDocument,
  document: vscode.TextDocument,
): Option.Option<vscode.NotebookCell> {
  return Option.fromNullable(
    notebook
      .getCells()
      .find((cell) => cell.document.uri.toString() === document.uri.toString()),
  );
}

function codeSignatureHelpContextToLsp(
  context: vscode.SignatureHelpContext,
): lsp.SignatureHelpContext {
  const triggerKindMapping = {
    [1 satisfies vscode.SignatureHelpTriggerKind.Invoke]:
      lsp.SignatureHelpTriggerKind.Invoked,
    [2 satisfies vscode.SignatureHelpTriggerKind.TriggerCharacter]:
      lsp.SignatureHelpTriggerKind.TriggerCharacter,
    [3 satisfies vscode.SignatureHelpTriggerKind.ContentChange]:
      lsp.SignatureHelpTriggerKind.ContentChange,
  };

  return {
    triggerKind: triggerKindMapping[context.triggerKind],
    triggerCharacter: context.triggerCharacter,
    isRetrigger: context.isRetrigger,
    activeSignatureHelp: context.activeSignatureHelp
      ? {
          signatures: context.activeSignatureHelp.signatures.map(
            ({ documentation, parameters, ...sig }) => ({
              ...sig,
              parameters: parameters.map(({ documentation, ...param }) => ({
                ...param,
                documentation: codeDocumentationToLsp(documentation),
              })),
              documentation: codeDocumentationToLsp(documentation),
            }),
          ),
          activeSignature: context.activeSignatureHelp.activeSignature,
          activeParameter: context.activeSignatureHelp.activeParameter,
        }
      : undefined,
  };
}

function codeCompletionContextToLsp(
  context: vscode.CompletionContext,
): lsp.CompletionContext {
  const mapping = {
    [0 satisfies vscode.CompletionTriggerKind.Invoke]:
      lsp.CompletionTriggerKind.Invoked,
    [1 satisfies vscode.CompletionTriggerKind.TriggerCharacter]:
      lsp.CompletionTriggerKind.TriggerCharacter,
    [2 satisfies vscode.CompletionTriggerKind.TriggerForIncompleteCompletions]:
      lsp.CompletionTriggerKind.TriggerForIncompleteCompletions,
  };
  return {
    triggerKind: mapping[context.triggerKind],
    triggerCharacter: context.triggerCharacter,
  };
}

/**
 * Convert LSP CompletionItem to VS Code CompletionItem, mapping ranges from virtual
 * document coordinates to cell coordinates
 */
function lspCompletionItemToVscode(
  lspItem: lsp.CompletionItem,
  options: {
    code: VsCode;
    mapper: { fromVirtual: (pos: vscode.Position) => vscode.Position };
  },
): vscode.CompletionItem {
  const { code, mapper } = options;
  const newItem = new code.CompletionItem(lspItem.label, lspItem.kind);

  // Add (marimo) suffix to detail to identify our completions
  newItem.detail = lspItem.detail;
  newItem.documentation = lspDocumentationToVscode(lspItem.documentation, code);

  newItem.sortText = lspItem.sortText;
  newItem.filterText = lspItem.filterText;
  newItem.insertText = lspItem.insertText;
  newItem.commitCharacters = lspItem.commitCharacters;
  newItem.command = lspItem.command;
  newItem.preselect = lspItem.preselect;

  // Map textEdit range from virtual document coordinates to cell coordinates
  if (lspItem.textEdit) {
    // Check if it's an InsertReplaceEdit (has insert/replace)
    if ("insert" in lspItem.textEdit && "replace" in lspItem.textEdit) {
      const { insert, replace, newText } = lspItem.textEdit;
      newItem.range = {
        inserting: new code.Range(
          mapper.fromVirtual(
            new code.Position(insert.start.line, insert.start.character),
          ),
          mapper.fromVirtual(
            new code.Position(insert.end.line, insert.end.character),
          ),
        ),
        replacing: new code.Range(
          mapper.fromVirtual(
            new code.Position(replace.start.line, replace.start.character),
          ),
          mapper.fromVirtual(
            new code.Position(replace.end.line, replace.end.character),
          ),
        ),
      };
      newItem.insertText = newText;
    } else if ("range" in lspItem.textEdit) {
      // Regular TextEdit
      const { range, newText } = lspItem.textEdit;
      newItem.range = new code.Range(
        mapper.fromVirtual(
          new code.Position(range.start.line, range.start.character),
        ),
        mapper.fromVirtual(
          new code.Position(range.end.line, range.end.character),
        ),
      );
      newItem.insertText = newText;
    }
  }

  return newItem;
}

/**
 * Convert VS Code documentation format to LSP MarkupContent format
 */
function codeDocumentationToLsp(
  documentation: string | vscode.MarkdownString | undefined,
): string | lsp.MarkupContent | undefined {
  if (!documentation) {
    return undefined;
  }

  if (typeof documentation === "object" && "value" in documentation) {
    return {
      kind: lsp.MarkupKind.Markdown,
      value: documentation.value,
    };
  }

  return documentation;
}

/**
 * Convert LSP MarkupContent format to VS Code MarkdownString
 */
function lspDocumentationToVscode(
  documentation: string | lsp.MarkupContent | lsp.MarkedString | undefined,
  code: VsCode,
): string | vscode.MarkdownString | undefined {
  if (!documentation) {
    return undefined;
  }

  if (typeof documentation === "object" && "value" in documentation) {
    const md = new code.MarkdownString(documentation.value);
    md.isTrusted = true;
    return md;
  }

  const md = new code.MarkdownString(documentation);
  md.isTrusted = true;
  return md;
}

/**
 * Convert LSP Hover to VS Code Hover, mapping ranges from virtual
 * document coordinates to cell coordinates
 */
function lspHoverToVscode(
  hover: lsp.Hover,
  options: {
    code: VsCode;
    mapper: {
      fromVirtual: (pos: vscode.Position) => vscode.Position;
    };
  },
): vscode.Hover {
  const { code, mapper } = options;

  // Convert contents
  const contents = Array.isArray(hover.contents)
    ? hover.contents
        .map((x) => lspDocumentationToVscode(x, code))
        .filter((x) => x !== undefined)
    : [lspDocumentationToVscode(hover.contents, code)].filter(
        (x) => x !== undefined,
      );

  // Convert range if present
  if (hover.range) {
    const range = new code.Range(
      mapper.fromVirtual(
        new code.Position(hover.range.start.line, hover.range.start.character),
      ),
      mapper.fromVirtual(
        new code.Position(hover.range.end.line, hover.range.end.character),
      ),
    );
    return new code.Hover(contents, range);
  }

  return new code.Hover(contents);
}

/**
 * Convert LSP SignatureHelp to VS Code SignatureHelp
 */
function lspSignatureHelpToVscode(
  signatureHelp: lsp.SignatureHelp,
  options: { code: VsCode },
): vscode.SignatureHelp {
  const { code } = options;
  return {
    activeSignature: signatureHelp.activeSignature ?? 0,
    activeParameter: signatureHelp.activeParameter ?? 0,
    signatures: signatureHelp.signatures.map((sig) => {
      const signature = new code.SignatureInformation(sig.label);
      signature.documentation = lspDocumentationToVscode(
        sig.documentation,
        code,
      );

      if (sig.parameters) {
        signature.parameters = sig.parameters.map((param) => {
          const paramInfo = new code.ParameterInformation(param.label);
          paramInfo.documentation = lspDocumentationToVscode(
            param.documentation,
            code,
          );
          return paramInfo;
        });
      }

      return signature;
    }),
  };
}
