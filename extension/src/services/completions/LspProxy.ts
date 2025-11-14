import { Effect, Option } from "effect";
import type * as vscode from "vscode";
import { VsCode } from "../VsCode.ts";
import { VirtualDocumentProvider } from "./VirtualDocumentProvider.ts";

export class LspProxy extends Effect.Service<LspProxy>()("LspProxy", {
  dependencies: [VirtualDocumentProvider.Default],
  scoped: Effect.gen(function* () {
    const code = yield* VsCode;
    const virtualDocs = yield* VirtualDocumentProvider;
    const channel = yield* code.window.createOutputChannel("marimo - LspProxy");

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
          channel.appendLine(
            `\nCompletion requested for ${document.uri.toString()} at ${position.line}:${position.character}`,
          );
          const pair = yield* findNotebookCellPair(document);

          if (Option.isNone(pair)) {
            channel.appendLine("  ❌ Document is not part of a notebook");
            return null;
          }

          const { notebook, cell } = pair.value;
          const info = yield* virtualDocs.getVirtualDocument(notebook);
          const mapper = yield* virtualDocs.getMapperForCell(cell);

          channel.appendLine(`  📓 Notebook: ${notebook.uri.toString()}`);
          channel.appendLine(`  📄 Cell index: ${cell.index}`);

          // Log cell content with cursor indicator
          channel.appendLine("\n  📝 Cell content at cursor:");
          const cellLines = document.getText().split("\n");
          const cellCursorLine = position.line;
          const cellCursorChar = position.character;

          // Show context around cursor (3 lines before and after)
          const cellStartLine = Math.max(0, cellCursorLine - 3);
          const cellEndLine = Math.min(
            cellLines.length - 1,
            cellCursorLine + 3,
          );

          for (let i = cellStartLine; i <= cellEndLine; i++) {
            const lineNum = String(i + 1).padStart(4, " ");
            channel.appendLine(`  ${lineNum} | ${cellLines[i]}`);

            // Add cursor indicator
            if (i === cellCursorLine) {
              const padding = " ".repeat(cellCursorChar);
              channel.appendLine(`       | ${padding}^`);
            }
          }
          channel.appendLine("");

          // Map cell position to virtual document position
          const virtualPosition = mapper.toVirtual(position);
          channel.appendLine(
            `  🎯 Mapped position: ${virtualPosition.line}:${virtualPosition.character}`,
          );

          // Log virtual document with cursor indicator
          channel.appendLine("\n  📄 Virtual document at cursor:");
          const lines = info.content.split("\n");
          const cursorLine = virtualPosition.line;
          const cursorChar = virtualPosition.character;

          // Show context around cursor (3 lines before and after)
          const startLine = Math.max(0, cursorLine - 3);
          const endLine = Math.min(lines.length - 1, cursorLine + 3);

          for (let i = startLine; i <= endLine; i++) {
            const lineNum = String(i + 1).padStart(4, " ");
            channel.appendLine(`  ${lineNum} | ${lines[i]}`);

            // Add cursor indicator
            if (i === cursorLine) {
              const padding = " ".repeat(cursorChar);
              channel.appendLine(`       | ${padding}^`);
            }
          }
          channel.appendLine("");

          // Query completions from virtual document
          const maybeCompletions = yield* code.commands.executeCommand(
            "vscode.executeCompletionItemProvider",
            info.uri,
            virtualPosition,
            context.triggerCharacter,
          );

          const completions = maybeCompletions as vscode.CompletionList;
          channel.appendLine(
            `  ✅ Got ${completions?.items?.length || 0} completions`,
          );

          if (!completions?.items) {
            return null;
          }

          // Clone completion items and map ranges back to cell coordinates
          const items = completions.items.map((item) => {
            const newItem = new code.CompletionItem(item.label, item.kind);
            // Add (marimo) suffix to detail to identify our completions
            newItem.detail = item.detail
              ? `${item.detail} (marimo)`
              : "(marimo)";
            newItem.documentation = item.documentation;
            newItem.sortText = item.sortText;
            newItem.filterText = item.filterText;
            newItem.insertText = item.insertText;
            newItem.commitCharacters = item.commitCharacters;
            newItem.command = item.command;
            newItem.preselect = item.preselect;

            // Map range from virtual document coordinates to cell coordinates
            if (item.range) {
              // Check if it's an InsertReplaceEdit (has inserting/replacing)
              if ("inserting" in item.range && "replacing" in item.range) {
                const { inserting, replacing } = item.range;
                newItem.range = {
                  inserting: new code.Range(
                    mapper.fromVirtual(inserting.start),
                    mapper.fromVirtual(inserting.end),
                  ),
                  replacing: new code.Range(
                    mapper.fromVirtual(replacing.start),
                    mapper.fromVirtual(replacing.end),
                  ),
                };
              } else {
                // Regular Range
                newItem.range = new code.Range(
                  mapper.fromVirtual(item.range.start),
                  mapper.fromVirtual(item.range.end),
                );
              }
            }

            return newItem;
          });
          // preview
          channel.appendLine("  🔍 Sample cloned completion items:");
          channel.appendLine(
            items
              .slice(0, Math.min(10, items.length))
              .map((it) => `    - ${it.label} ${it.detail}`)
              .join("\n"),
          );

          channel.appendLine(`  📦 Returning ${items.length} cloned items`);

          return new code.CompletionList(items, completions.isIncomplete);
        }),

      provideHover: (
        document: vscode.TextDocument,
        position: vscode.Position,
      ) =>
        Effect.gen(function* () {
          channel.appendLine(
            `\nHover requested for ${document.uri.toString()} at ${position.line}:${position.character}`,
          );
          const pair = yield* findNotebookCellPair(document);

          if (Option.isNone(pair)) {
            return null;
          }

          const { notebook, cell } = pair.value;
          const mapper = yield* virtualDocs.getMapperForCell(cell);
          const info = yield* virtualDocs.getVirtualDocument(notebook);

          // Map cell position to virtual document position
          const virtualPosition = mapper.toVirtual(position);

          // Query hover from virtual document
          const hoversResponse = yield* code.commands.executeCommand(
            "vscode.executeHoverProvider",
            info.uri,
            virtualPosition,
          );

          const hovers = hoversResponse as vscode.Hover[];

          if (!hovers || hovers.length === 0) {
            return null;
          }

          // Return first hover (VSCode typically returns array with one item)
          // No need to map ranges for hover - it's display only
          return hovers[0];
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

          // Query definition from virtual document
          const result = yield* code.commands.executeCommand(
            "vscode.executeDefinitionProvider",
            info.uri,
            virtualPosition,
          );

          const definitions = result as vscode.Location[];

          if (!definitions || definitions.length === 0) {
            return null;
          }

          // Map definition locations back to cell coordinates
          const mappedDefinitions: vscode.Location[] = [];

          for (const def of definitions) {
            // Check if definition is in the virtual document
            if (def.uri.toString() === info.uri.toString()) {
              // Map back to cell position
              const cellPosition = mapper.fromVirtual(def.range.start);
              mappedDefinitions.push(
                new code.Location(
                  cell.document.uri,
                  new code.Position(cellPosition.line, cellPosition.character),
                ),
              );
            } else {
              // Definition is in another file, return as-is
              mappedDefinitions.push(def);
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

          const result = yield* code.commands.executeCommand(
            "vscode.executeSignatureHelpProvider",
            info.uri,
            mapper.toVirtual(position),
            context.triggerCharacter,
          );

          const signatureHelp = result as vscode.SignatureHelp;
          return signatureHelp;
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
