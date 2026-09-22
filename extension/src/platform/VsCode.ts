import { Context, Data, Effect, Layer, Option, Result } from "effect";

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
import * as Auth from "./Auth.ts";
import * as Commands from "./Commands.ts";
import * as Debug from "./Debug.ts";
import * as Env from "./Env.ts";
import * as Languages from "./Languages.ts";
import * as Notebooks from "./Notebooks.ts";
import * as Window from "./Window.ts";
import * as Workspace from "./Workspace.ts";

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
      notebooks: yield* Notebooks.Service,
      auth: yield* Auth.Service,
      languages: yield* Languages.Service,
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
