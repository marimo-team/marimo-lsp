import { Context, Data, Effect, Layer, Option, Result, Scope } from "effect";

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

export class ParseUriError extends Data.TaggedError("VsCode.ParseUriError")<{
  readonly cause: unknown;
}> {}

export interface Interface {
  readonly window: Window.Interface;
  readonly commands: Commands.Interface;
  readonly workspace: Workspace.Interface;
  readonly env: Env.Interface;
  readonly debug: Debug.Interface;
  readonly notebooks: Notebooks.Interface;
  readonly auth: Auth.Interface;
  readonly languages: Languages.Interface;
  readonly Diagnostic: typeof vscode.Diagnostic;
  readonly DiagnosticSeverity: typeof vscode.DiagnosticSeverity;
  readonly CodeActionTriggerKind: typeof vscode.CodeActionTriggerKind;
  readonly Hover: typeof vscode.Hover;
  readonly TextEdit: typeof vscode.TextEdit;
  readonly SignatureHelp: typeof vscode.SignatureHelp;
  readonly InlayHint: typeof vscode.InlayHint;
  readonly InlayHintLabelPart: typeof vscode.InlayHintLabelPart;
  readonly SnippetString: typeof vscode.SnippetString;
  readonly CodeAction: typeof vscode.CodeAction;
  readonly CodeActionKind: typeof vscode.CodeActionKind;
  readonly CompletionTriggerKind: typeof vscode.CompletionTriggerKind;
  readonly CompletionItem: typeof vscode.CompletionItem;
  readonly CompletionItemKind: typeof vscode.CompletionItemKind;
  readonly CompletionList: typeof vscode.CompletionList;
  readonly MarkdownString: typeof vscode.MarkdownString;
  readonly SignatureInformation: typeof vscode.SignatureInformation;
  readonly ParameterInformation: typeof vscode.ParameterInformation;
  readonly CodeLens: typeof vscode.CodeLens;
  readonly DocumentHighlight: typeof vscode.DocumentHighlight;
  readonly DocumentSymbol: typeof vscode.DocumentSymbol;
  readonly FoldingRange: typeof vscode.FoldingRange;
  readonly SelectionRange: typeof vscode.SelectionRange;
  readonly SemanticTokensLegend: typeof vscode.SemanticTokensLegend;
  readonly SemanticTokens: typeof vscode.SemanticTokens;
  readonly LanguageModelToolResult: typeof vscode.LanguageModelToolResult;
  readonly LanguageModelTextPart: typeof vscode.LanguageModelTextPart;
  readonly NotebookData: typeof vscode.NotebookData;
  readonly NotebookCellData: typeof vscode.NotebookCellData;
  readonly NotebookCellKind: typeof vscode.NotebookCellKind;
  readonly NotebookCellOutput: typeof vscode.NotebookCellOutput;
  readonly NotebookCellOutputItem: typeof vscode.NotebookCellOutputItem;
  readonly NotebookEditorRevealType: typeof vscode.NotebookEditorRevealType;
  readonly NotebookEdit: typeof vscode.NotebookEdit;
  readonly NotebookRange: typeof vscode.NotebookRange;
  readonly NotebookCellStatusBarItem: typeof vscode.NotebookCellStatusBarItem;
  readonly NotebookControllerAffinity: typeof vscode.NotebookControllerAffinity;
  readonly NotebookCellStatusBarAlignment: typeof vscode.NotebookCellStatusBarAlignment;
  readonly WorkspaceEdit: typeof vscode.WorkspaceEdit;
  readonly Position: typeof vscode.Position;
  readonly EventEmitter: typeof vscode.EventEmitter;
  readonly DebugAdapterInlineImplementation: typeof vscode.DebugAdapterInlineImplementation;
  readonly ProgressLocation: typeof vscode.ProgressLocation;
  readonly ThemeIcon: typeof vscode.ThemeIcon;
  readonly TreeItem: typeof vscode.TreeItem;
  readonly TreeItemCollapsibleState: typeof vscode.TreeItemCollapsibleState;
  readonly ThemeColor: typeof vscode.ThemeColor;
  readonly StatusBarAlignment: typeof vscode.StatusBarAlignment;
  readonly Location: typeof vscode.Location;
  readonly Uri: typeof vscode.Uri;
  readonly Range: typeof vscode.Range;
  readonly RelativePattern: typeof vscode.RelativePattern;
  readonly version: string;
  readonly extensions: {
    readonly getExtension: <T = unknown>(
      extensionId: string,
    ) => Option.Option<vscode.Extension<T>>;
  };
  readonly lm: {
    readonly registerTool: <T>(
      name: string,
      tool: vscode.LanguageModelTool<T>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  };
  readonly utils: {
    readonly parseUri: (
      value: string,
    ) => Result.Result<vscode.Uri, ParseUriError>;
  };
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/VsCode",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Expose the raw vscode module for runtime inspection via --inspect-extensions.
    // Only active when MARIMO_DEBUG=1 (set by launch-dev.sh).
    if (process.env.MARIMO_DEBUG === "1") {
      // oxlint-disable-next-line eslint/no-underscore-dangle
      globalThis.__marimoVsCode = vscode;
    }

    const getExtension = <T = unknown>(extensionId: string) =>
      Option.fromNullishOr(vscode.extensions.getExtension<T>(extensionId));

    const registerTool = Effect.fn("VsCode.lm.registerTool")(function* <T>(
      name: string,
      tool: vscode.LanguageModelTool<T>,
    ) {
      yield* acquireDisposable(() => vscode.lm.registerTool(name, tool));
    });

    const parseUri = (value: string) =>
      Result.try({
        try: () => vscode.Uri.parse(value, /* strict*/ true),
        catch: (cause) => new ParseUriError({ cause }),
      });

    return Service.of({
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
      extensions: { getExtension },
      lm: { registerTool },
      utils: { parseUri },
    });
  }),
).pipe(
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
