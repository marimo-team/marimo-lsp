import * as NodeEvents from "node:events";
import * as NodePath from "node:path";

import {
  Context,
  Data,
  Deferred,
  Effect,
  HashSet,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Result,
  Stream,
  SubscriptionRef,
} from "effect";
import type * as vscode from "vscode";

import { commandId, decodeCommandResult } from "../commands.ts";
import { NOTEBOOK_TYPE } from "../constants.ts";
import { acquireDisposable } from "../lib/acquireDisposable.ts";
import * as Commands from "../platform/Commands.ts";
import * as Env from "../platform/Env.ts";
import * as VsCode from "../platform/VsCode.ts";
import * as Window from "../platform/Window.ts";
import * as Workspace from "../platform/Workspace.ts";
import type { RendererCommand, RendererReceiveMessage } from "../types.ts";

class NotebookCellData implements vscode.NotebookCellData {
  kind: vscode.NotebookCellKind;
  value: string;
  languageId: string;
  outputs?: vscode.NotebookCellOutput[];
  metadata?: { [key: string]: unknown };
  executionSummary?: vscode.NotebookCellExecutionSummary;
  constructor(
    kind: vscode.NotebookCellKind,
    value: string,
    languageId: string,
  ) {
    this.kind = kind;
    this.value = value;
    this.languageId = languageId;
  }
}

class NotebookData implements vscode.NotebookData {
  cells: vscode.NotebookCellData[];
  metadata?: { [key: string]: unknown };
  constructor(cells: NotebookCellData[]) {
    this.cells = cells;
  }
}

class NotebookCellOutput implements NotebookCellOutput {
  items: NotebookCellOutputItem[];
  metadata?: { [key: string]: unknown };
  constructor(
    items: NotebookCellOutputItem[],
    metadata?: { [key: string]: unknown },
  ) {
    this.items = items;
    this.metadata = metadata;
  }
}

class NotebookCellOutputItem implements NotebookCellOutputItem {
  static text(
    value: string,
    mime: string = "text/plain",
  ): NotebookCellOutputItem {
    const encoder = new TextEncoder();
    return new NotebookCellOutputItem(encoder.encode(value), mime);
  }
  static json(
    value: unknown,
    mime: string = "application/json",
  ): NotebookCellOutputItem {
    const encoder = new TextEncoder();
    return new NotebookCellOutputItem(
      encoder.encode(JSON.stringify(value)),
      mime,
    );
  }
  static stdout(value: string): NotebookCellOutputItem {
    const encoder = new TextEncoder();
    return new NotebookCellOutputItem(
      encoder.encode(value),
      "application/vnd.code.notebook.stdout",
    );
  }
  static stderr(value: string): NotebookCellOutputItem {
    const encoder = new TextEncoder();
    return new NotebookCellOutputItem(
      encoder.encode(value),
      "application/vnd.code.notebook.stderr",
    );
  }
  static error(value: Error): NotebookCellOutputItem {
    const encoder = new TextEncoder();
    return new NotebookCellOutputItem(
      encoder.encode(
        JSON.stringify({
          name: value.name,
          message: value.message,
          stack: value.stack,
        }),
      ),
      "application/vnd.code.notebook.error",
    );
  }
  data: Uint8Array;
  mime: string;
  constructor(data: Uint8Array, mime: string) {
    this.data = data;
    this.mime = mime;
  }
}

export class NotebookRange implements vscode.NotebookRange {
  readonly start: number;
  readonly end: number;
  get isEmpty(): boolean {
    return this.start === this.end;
  }
  constructor(start: number, end: number) {
    this.start = start;
    this.end = end;
  }
  with(change: { start?: number; end?: number }): NotebookRange {
    const newStart = change.start ?? this.start;
    const newEnd = change.end ?? this.end;
    if (newStart === this.start && newEnd === this.end) {
      return this;
    }
    return new NotebookRange(newStart, newEnd);
  }
}

class LanguageModelTextPart implements vscode.LanguageModelTextPart {
  value: string;
  constructor(value: string) {
    this.value = value;
  }
}

class LanguageModelToolResult implements vscode.LanguageModelToolResult {
  content: unknown[];
  constructor(content: unknown[]) {
    this.content = content;
  }
}

class NotebookEdit implements vscode.NotebookEdit {
  static replaceCells(
    range: NotebookRange,
    newCells: NotebookCellData[],
  ): NotebookEdit {
    return new NotebookEdit(range, newCells);
  }
  static insertCells(
    index: number,
    newCells: NotebookCellData[],
  ): NotebookEdit {
    return new NotebookEdit(new NotebookRange(index, index), newCells);
  }
  static deleteCells(range: NotebookRange): NotebookEdit {
    return new NotebookEdit(range, []);
  }
  static updateCellMetadata(
    index: number,
    newCellMetadata: { [key: string]: unknown },
  ): NotebookEdit {
    const edit = new NotebookEdit(new NotebookRange(index, index + 1), []);
    edit.newCellMetadata = newCellMetadata;
    return edit;
  }
  static updateNotebookMetadata(newNotebookMetadata: {
    [key: string]: unknown;
  }): NotebookEdit {
    const edit = new NotebookEdit(new NotebookRange(0, 0), []);
    edit.newNotebookMetadata = newNotebookMetadata;
    return edit;
  }
  range: NotebookRange;
  newCells: NotebookCellData[];
  newCellMetadata?: { [key: string]: unknown };
  newNotebookMetadata?: { [key: string]: unknown };
  constructor(range: NotebookRange, newCells: NotebookCellData[]) {
    this.range = range;
    this.newCells = newCells;
  }
}

class NotebookCellStatusBarItem implements vscode.NotebookCellStatusBarItem {
  text: string;
  alignment: vscode.NotebookCellStatusBarAlignment;
  command?: string | vscode.Command;
  tooltip?: string;
  priority?: number;
  accessibilityInformation?: vscode.AccessibilityInformation;
  constructor(text: string, alignment: vscode.NotebookCellStatusBarAlignment) {
    this.text = text;
    this.alignment = alignment;
  }
}

export class Uri implements vscode.Uri {
  static parse(value: string, _strict?: boolean): Uri {
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
    if (!hasScheme) {
      throw new Error(`Invalid URI: missing scheme in '${value}'`);
    }
    const url = new URL(value);
    return new Uri(
      url.protocol.slice(0, -1),
      url.host,
      url.pathname,
      url.search.slice(1),
      url.hash.slice(1),
    );
  }

  static file(path: string): Uri {
    let normalized = path.replace(/\\/g, "/");
    if (!normalized.startsWith("/")) {
      normalized = `/${normalized}`;
    }
    return new Uri("file", "", normalized, "", "");
  }

  static joinPath(base: Uri, ...pathSegments: string[]): Uri {
    return new Uri(
      base.scheme,
      base.authority,
      NodePath.posix.join(base.path, ...pathSegments),
      base.query,
      base.fragment,
    );
  }

  static from(components: {
    readonly scheme: string;
    readonly authority?: string;
    readonly path?: string;
    readonly query?: string;
    readonly fragment?: string;
  }): Uri {
    return new Uri(
      components.scheme,
      components.authority ?? "",
      components.path ?? "",
      components.query ?? "",
      components.fragment ?? "",
    );
  }

  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;

  private constructor(
    scheme: string,
    authority: string,
    path: string,
    query: string,
    fragment: string,
  ) {
    this.scheme = scheme;
    this.authority = authority;
    this.fragment = fragment;
    this.path = path;
    this.query = query;
  }

  get fsPath(): string {
    if (this.scheme !== "file") {
      return this.path;
    }
    // Handle UNC paths
    if (this.authority) {
      return (
        NodePath.sep +
        NodePath.sep +
        this.authority +
        this.path.replace(/\//g, NodePath.sep)
      );
    }
    // Handle drive letters on Windows
    let fsPath = this.path;
    if (process.platform === "win32" && fsPath.match(/^\/[a-zA-Z]:/)) {
      fsPath = fsPath.substring(1); // Remove leading /
    }
    return fsPath.replace(/\//g, NodePath.sep);
  }
  with(change: {
    scheme?: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    const {
      scheme = this.scheme,
      authority = this.authority,
      path = this.path,
      query = this.query,
      fragment = this.fragment,
    } = change;
    if (
      scheme === this.scheme &&
      authority === this.authority &&
      path === this.path &&
      query === this.query &&
      fragment === this.fragment
    ) {
      return this;
    }
    return new Uri(scheme, authority, path, query, fragment);
  }
  toString(skipEncoding?: boolean): string {
    if (skipEncoding) {
      // Return the URI without percent-encoding (matches real VS Code behavior)
      let result = "";
      if (this.scheme) {
        result += `${this.scheme}://`;
      }
      if (this.authority) {
        result += this.authority;
      }
      result += this.path;
      if (this.query) {
        result += `?${this.query}`;
      }
      if (this.fragment) {
        result += `#${this.fragment}`;
      }
      return result;
    }
    const url = new URL(this.scheme ? `${this.scheme}:` : "");
    url.protocol = this.scheme ? `${this.scheme}:` : "";
    url.host = this.authority;
    url.pathname = this.path;
    url.search = this.query ? `?${this.query}` : "";
    url.hash = this.fragment ? `#${this.fragment}` : "";
    return url.href;
  }
  toJSON(): Record<string, string> {
    return {
      scheme: this.scheme,
      authority: this.authority,
      path: this.path,
      query: this.query,
      fragment: this.fragment,
    };
  }
}

export function createNotebookUri(path: string): Uri {
  return Uri.file(path);
}

class Position implements vscode.Position {
  readonly line: number;
  readonly character: number;

  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }
  isBefore(other: Position): boolean {
    return this.compareTo(other) < 0;
  }
  isBeforeOrEqual(other: Position): boolean {
    return this.compareTo(other) <= 0;
  }
  isAfter(other: Position): boolean {
    return this.compareTo(other) > 0;
  }
  isAfterOrEqual(other: Position): boolean {
    return this.compareTo(other) >= 0;
  }
  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }
  compareTo(other: Position): number {
    if (this.line < other.line) return -1;
    if (this.line > other.line) return 1;
    if (this.character < other.character) return -1;
    if (this.character > other.character) return 1;
    return 0;
  }
  translate(lineDelta?: number, characterDelta?: number): Position;
  translate(change: { lineDelta?: number; characterDelta?: number }): Position;
  translate(
    lineDeltaOrChange?:
      | number
      | { lineDelta?: number; characterDelta?: number },
    characterDelta?: number,
  ): Position {
    let lineDelta: number;
    let charDelta: number;
    if (typeof lineDeltaOrChange === "number") {
      lineDelta = lineDeltaOrChange ?? 0;
      charDelta = characterDelta ?? 0;
    } else if (lineDeltaOrChange) {
      lineDelta = lineDeltaOrChange.lineDelta ?? 0;
      charDelta = lineDeltaOrChange.characterDelta ?? 0;
    } else {
      lineDelta = 0;
      charDelta = 0;
    }
    if (lineDelta === 0 && charDelta === 0) {
      return this;
    }
    return new Position(this.line + lineDelta, this.character + charDelta);
  }

  with(line?: number, character?: number): Position;
  with(change: { line?: number; character?: number }): Position;
  with(
    lineOrChange?: number | { line?: number; character?: number },
    character?: number,
  ): Position {
    let newLine: number;
    let newCharacter: number;
    if (typeof lineOrChange === "number") {
      newLine = lineOrChange ?? this.line;
      newCharacter = character ?? this.character;
    } else if (lineOrChange) {
      newLine = lineOrChange.line ?? this.line;
      newCharacter = lineOrChange.character ?? this.character;
    } else {
      newLine = this.line;
      newCharacter = this.character;
    }
    if (newLine === this.line && newCharacter === this.character) {
      return this;
    }
    return new Position(newLine, newCharacter);
  }
}

class Range implements vscode.Range {
  readonly start: Position;
  readonly end: Position;

  constructor(start: Position, end: Position);
  constructor(
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
  );
  constructor(
    startOrLine: Position | number,
    endOrCharacter: Position | number,
    endLine?: number,
    endCharacter?: number,
  ) {
    // SAFETY: overload signatures guarantee that when `startOrLine` is a
    // number, the remaining params are all numbers; and when it's a Position,
    // `endOrCharacter` is a Position. The implementation signature has to
    // accept the merged type. Non-null asserts are similarly backed by the
    // overloads.
    if (typeof startOrLine === "number") {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      this.start = new Position(startOrLine, endOrCharacter as number);
      // oxlint-disable-next-line typescript/no-non-null-assertion
      this.end = new Position(endLine!, endCharacter!);
    } else {
      this.start = startOrLine;
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      this.end = endOrCharacter as Position;
    }

    // Swap if start is after end
    if (this.start.isAfter(this.end)) {
      [this.start, this.end] = [this.end, this.start];
    }
  }

  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }
  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }

  contains(positionOrRange: Position | Range): boolean {
    if (positionOrRange instanceof Range) {
      return (
        this.start.isBeforeOrEqual(positionOrRange.start) &&
        this.end.isAfterOrEqual(positionOrRange.end)
      );
    }
    return (
      this.start.isBeforeOrEqual(positionOrRange) &&
      this.end.isAfterOrEqual(positionOrRange)
    );
  }

  isEqual(other: Range): boolean {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }

  intersection(range: Range): Range | undefined {
    const start = this.start.isAfter(range.start) ? this.start : range.start;
    const end = this.end.isBefore(range.end) ? this.end : range.end;
    if (start.isAfter(end)) {
      return undefined;
    }
    return new Range(start, end);
  }

  union(other: Range): Range {
    const start = this.start.isBefore(other.start) ? this.start : other.start;
    const end = this.end.isAfter(other.end) ? this.end : other.end;
    return new Range(start, end);
  }

  with(start?: Position, end?: Position): Range;
  with(change: { start?: Position; end?: Position }): Range;
  with(
    startOrChange?: Position | { start?: Position; end?: Position },
    end?: Position,
  ): Range {
    let newStart: Position;
    let newEnd: Position;
    if (startOrChange instanceof Position || startOrChange === undefined) {
      newStart = startOrChange ?? this.start;
      newEnd = end ?? this.end;
    } else {
      newStart = startOrChange.start ?? this.start;
      newEnd = startOrChange.end ?? this.end;
    }
    if (newStart.isEqual(this.start) && newEnd.isEqual(this.end)) {
      return this;
    }
    return new Range(newStart, newEnd);
  }
}

class RelativePattern implements vscode.RelativePattern {
  baseUri: vscode.Uri;
  base: string;
  pattern: string;

  constructor(
    base: vscode.WorkspaceFolder | vscode.Uri | string,
    pattern: string,
  ) {
    if (typeof base === "string") {
      this.baseUri = Uri.file(base);
    } else if ("uri" in base) {
      this.baseUri = base.uri;
    } else {
      this.baseUri = base;
    }
    this.base = this.baseUri.fsPath;
    this.pattern = pattern;
  }
}

class CodeLens implements vscode.CodeLens {
  readonly range: Range;
  command?: vscode.Command;
  readonly isResolved: boolean;

  constructor(range: Range, command?: vscode.Command) {
    this.range = range;
    this.command = command;
    this.isResolved = command !== undefined;
  }
}

class SemanticTokensLegend implements vscode.SemanticTokensLegend {
  readonly tokenTypes: string[];
  readonly tokenModifiers: string[];

  constructor(tokenTypes: string[], tokenModifiers: string[] = []) {
    this.tokenTypes = tokenTypes;
    this.tokenModifiers = tokenModifiers;
  }
}

class SemanticTokens implements vscode.SemanticTokens {
  readonly resultId: string | undefined;
  readonly data: Uint32Array;

  constructor(data: Uint32Array, resultId?: string) {
    this.data = data;
    this.resultId = resultId;
  }
}

class Selection extends Range implements vscode.Selection {
  readonly anchor: Position;
  readonly active: Position;

  constructor(anchor: Position, active: Position);
  constructor(
    anchorLine: number,
    anchorCharacter: number,
    activeLine: number,
    activeCharacter: number,
  );
  constructor(
    anchorOrLine: Position | number,
    activeOrCharacter: Position | number,
    activeLine?: number,
    activeCharacter?: number,
  ) {
    let anchor: Position;
    let active: Position;

    // SAFETY: see Range constructor above — overload signatures guarantee
    // the other param shapes when `anchorOrLine` is narrowed.
    if (typeof anchorOrLine === "number") {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      anchor = new Position(anchorOrLine, activeOrCharacter as number);
      // oxlint-disable-next-line typescript/no-non-null-assertion
      active = new Position(activeLine!, activeCharacter!);
    } else {
      anchor = anchorOrLine;
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      active = activeOrCharacter as Position;
    }

    // Call Range constructor with start and end
    // The start is the earlier position, end is the later position
    const start = anchor.isBefore(active) ? anchor : active;
    const end = anchor.isBefore(active) ? active : anchor;
    super(start, end);

    this.anchor = anchor;
    this.active = active;
  }

  get isReversed(): boolean {
    return this.anchor.isAfter(this.active);
  }
}

class TextEdit implements vscode.TextEdit {
  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }
  static insert(position: Position, newText: string): TextEdit {
    return new TextEdit(new Range(position, position), newText);
  }
  static delete(range: Range): TextEdit {
    return new TextEdit(range, "");
  }
  static setEndOfLine(eol: vscode.EndOfLine): TextEdit {
    const edit = new TextEdit(
      new Range(new Position(0, 0), new Position(0, 0)),
      "",
    );
    edit.newEol = eol;
    return edit;
  }
  range: vscode.Range;
  newText: string;
  newEol?: vscode.EndOfLine;
  constructor(range: Range, newText: string) {
    this.range = range;
    this.newText = newText;
  }
}

class WorkspaceEdit implements vscode.WorkspaceEdit {
  #fileOperationCount = 0;
  #edits = new Map<
    string,
    Array<vscode.TextEdit | vscode.SnippetTextEdit | NotebookEdit>
  >();
  #add(uri: Uri, edit: TextEdit | vscode.SnippetTextEdit | NotebookEdit): void {
    const key = uri.toString();
    const edits = this.#edits.get(key) || [];
    edits.push(edit);
    this.#edits.set(key, edits);
  }
  get size(): number {
    return this.#edits.size + this.#fileOperationCount;
  }
  replace(uri: vscode.Uri, range: Range, newText: string): void {
    const edit = TextEdit.replace(range, newText);
    this.#add(uri, edit);
  }
  insert(uri: Uri, position: vscode.Position, newText: string): void {
    const edit = TextEdit.insert(position, newText);
    this.#add(uri, edit);
  }
  delete(uri: Uri, range: Range): void {
    const edit = TextEdit.delete(range);
    this.#add(uri, edit);
  }
  has(uri: Uri): boolean {
    return this.#edits.has(uri.toString());
  }

  set(
    uri: Uri,
    edits:
      | ReadonlyArray<NotebookEdit | vscode.SnippetTextEdit | vscode.TextEdit>
      | ReadonlyArray<
          [
            edit: NotebookEdit | vscode.SnippetTextEdit | vscode.TextEdit,
            metadata: unknown,
          ]
        >,
  ): void {
    const key = uri.toString();
    function isTuples(
      arr: typeof edits,
    ): arr is ReadonlyArray<
      [
        edit: NotebookEdit | vscode.SnippetTextEdit | vscode.TextEdit,
        metadata: unknown,
      ]
    > {
      return Array.isArray(arr[0]);
    }
    if (isTuples(edits)) {
      // Array of tuples with metadata - extract just the edits
      this.#edits.set(
        key,
        edits.map((e) => e[0]),
      );
    } else {
      this.#edits.set(key, [...edits]);
    }
  }
  get(uri: Uri): TextEdit[] {
    const edits = this.#edits.get(uri.toString()) || [];
    return edits.filter((e) => e instanceof TextEdit);
  }
  getNotebookEdits(uri: Uri): readonly NotebookEdit[] {
    const edits = this.#edits.get(uri.toString()) || [];
    return edits.filter((edit) => edit instanceof NotebookEdit);
  }
  createFile(_uri: Uri): void {
    this.#fileOperationCount += 1;
  }
  deleteFile(_uri: Uri): void {
    this.#fileOperationCount += 1;
  }
  renameFile(_oldUri: Uri, _newUri: Uri): void {
    this.#fileOperationCount += 1;
  }
  entries(): [Uri, TextEdit[]][] {
    const result: [Uri, TextEdit[]][] = [];
    for (const [uriString, edits] of this.#edits) {
      const textEdits = edits.filter((e) => e instanceof TextEdit);
      result.push([Uri.parse(uriString, true), textEdits]);
    }
    return result;
  }
}

export function getNotebookEdits(edit: vscode.WorkspaceEdit, uri: vscode.Uri) {
  if (!(edit instanceof WorkspaceEdit)) {
    throw new Error("Expected test WorkspaceEdit");
  }
  return edit.getNotebookEdits(uri);
}

class EventEmitter<T> implements vscode.EventEmitter<T> {
  #emitter: NodeEvents.EventEmitter = new NodeEvents.EventEmitter();
  #disposed: boolean = false;

  // oxlint-disable-next-line typescript-eslint/no-unnecessary-type-parameters
  event = <T>(
    listener: (e: T) => unknown,
    thisArgs?: unknown,
    disposables?: vscode.Disposable[],
  ) => {
    if (this.#disposed) {
      return { dispose: () => {} };
    }
    const bound = thisArgs ? listener.bind(thisArgs) : listener;
    this.#emitter.on("event", bound);
    const disposable = {
      dispose: () => {
        this.#emitter.off("event", bound);
      },
    };
    disposables?.push(disposable);
    return disposable;
  };

  fire(data: T): void {
    if (this.#disposed) {
      return;
    }
    this.#emitter.emit("event", data);
  }
  dispose(): void {
    this.#disposed = true;
    this.#emitter.removeAllListeners();
  }
}

class ThemeColor implements vscode.ThemeColor {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

class ThemeIcon implements vscode.ThemeIcon {
  static readonly File: ThemeIcon;
  static readonly Folder: ThemeIcon;
  readonly id: string;
  readonly color?: ThemeColor | undefined;
  constructor(id: string, color?: ThemeColor) {
    this.id = id;
    this.color = color;
  }
}

class MarkdownString implements vscode.MarkdownString {
  value: string;
  isTrusted?: boolean | { readonly enabledCommands: readonly string[] };
  supportThemeIcons?: boolean;
  supportHtml?: boolean;
  baseUri?: Uri;
  constructor(value?: string, supportThemeIcons?: boolean) {
    this.value = value ?? "";
    this.supportThemeIcons = supportThemeIcons;
  }
  appendText(value: string): MarkdownString {
    // Escape markdown special characters
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\*/g, "\\*")
      .replace(/_/g, "\\_")
      .replace(/\{/g, "\\{")
      .replace(/\}/g, "\\}")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/#/g, "\\#")
      .replace(/\+/g, "\\+")
      .replace(/-/g, "\\-")
      .replace(/\./g, "\\.")
      .replace(/!/g, "\\!");
    this.value += escaped;
    return this;
  }
  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }
  appendCodeblock(value: string, language?: string): MarkdownString {
    this.value += `\n\`\`\`${language ?? ""}\n`;
    this.value += value;
    this.value += "\n```\n";
    return this;
  }
}

class TreeItem implements vscode.TreeItem {
  label?: string | vscode.TreeItemLabel;
  id?: string;
  iconPath?: string | vscode.IconPath;
  description?: string | boolean;
  resourceUri?: Uri;
  tooltip?: string | vscode.MarkdownString | undefined;
  command?: vscode.Command;
  collapsibleState?: vscode.TreeItemCollapsibleState;
  contextValue?: string;
  accessibilityInformation?: vscode.AccessibilityInformation;
  checkboxState?:
    | vscode.TreeItemCheckboxState
    | {
        readonly state: vscode.TreeItemCheckboxState;
        readonly tooltip?: string;
        readonly accessibilityInformation?: vscode.AccessibilityInformation;
      };

  constructor(
    label: string | vscode.TreeItemLabel,
    collapsibleState?: vscode.TreeItemCollapsibleState,
  );
  constructor(
    resourceUri: Uri,
    collapsibleState?: vscode.TreeItemCollapsibleState,
  );
  constructor(
    labelOrResourceUri: string | vscode.TreeItemLabel | Uri,
    collapsibleState?: vscode.TreeItemCollapsibleState,
  ) {
    if (labelOrResourceUri instanceof Uri) {
      this.resourceUri = labelOrResourceUri;
    } else {
      this.label = labelOrResourceUri;
    }
    this.collapsibleState = collapsibleState;
  }
}

class TextDocument implements vscode.TextDocument {
  readonly uri: Uri;
  readonly fileName: string;
  readonly isUntitled: boolean;
  readonly languageId: string;
  readonly version: number;
  readonly isDirty: boolean;
  readonly isClosed: boolean;
  readonly eol: vscode.EndOfLine;
  readonly lineCount: number;
  readonly encoding: string;

  #text: string;

  constructor(uri: Uri, languageId: string, version: number, text: string) {
    this.uri = uri;
    this.fileName = uri.fsPath;
    this.languageId = languageId;
    this.version = version;
    this.#text = text;
    this.isUntitled = false;
    this.isDirty = false;
    this.isClosed = false;
    this.eol = 1; // LF
    this.lineCount = text.split("\n").length;
    this.encoding = "utf-8";
  }

  save(): Thenable<boolean> {
    return Promise.resolve(true);
  }

  getText(range?: vscode.Range): string {
    if (!range) {
      return this.#text;
    }
    // For simplicity, just return full text for now
    return this.#text;
  }

  getWordRangeAtPosition(): vscode.Range | undefined {
    return undefined;
  }

  validateRange(range: vscode.Range): vscode.Range {
    return range;
  }

  validatePosition(position: vscode.Position): vscode.Position {
    return position;
  }

  positionAt(): vscode.Position {
    return new Position(0, 0);
  }

  offsetAt(): number {
    return 0;
  }

  lineAt(): vscode.TextLine {
    throw new Error("lineAt not implemented in test mock");
  }
}

class TextEditor implements vscode.TextEditor {
  readonly document: vscode.TextDocument;
  selections: readonly vscode.Selection[];
  visibleRanges: readonly vscode.Range[];
  options: vscode.TextEditorOptions;

  constructor(document: vscode.TextDocument) {
    this.document = document;
    this.selections = [new Selection(new Position(0, 0), new Position(0, 0))];
    this.visibleRanges = [];
    this.options = {};
  }

  get selection(): vscode.Selection {
    return this.selections[0];
  }

  get viewColumn(): never {
    throw Error("TextEditor.viewColumn is not implemented.");
  }

  edit(): Thenable<boolean> {
    return Promise.resolve(true);
  }

  insertSnippet(): Thenable<boolean> {
    return Promise.resolve(true);
  }

  setDecorations(): void {}

  revealRange(): void {}

  show(): void {}

  hide(): void {}
}

export function createTestTextDocument(
  uri: Uri | string,
  languageId: string,
  text: string,
): vscode.TextDocument {
  if (typeof uri === "string") {
    uri = Uri.file(uri);
  }
  return new TextDocument(uri, languageId, 1, text);
}

export function createTestTextEditor(
  document: vscode.TextDocument,
): vscode.TextEditor {
  return new TextEditor(document);
}

class NotebookCell implements vscode.NotebookCell {
  readonly index: number;
  readonly notebook: vscode.NotebookDocument;
  readonly kind: vscode.NotebookCellKind;
  readonly metadata: { readonly [key: string]: unknown };
  readonly outputs: readonly NotebookCellOutput[];
  readonly executionSummary: vscode.NotebookCellExecutionSummary | undefined;
  readonly document: vscode.TextDocument;

  constructor(
    notebook: vscode.NotebookDocument,
    data: vscode.NotebookCellData,
    index: number,
  ) {
    this.notebook = notebook;
    this.index = index;
    this.kind = data.kind;
    this.metadata = data.metadata ?? {};
    this.outputs = data.outputs ?? [];
    this.executionSummary = data.executionSummary;

    // Create a minimal TextDocument for the cell
    const cellUri = Uri.from({
      scheme: notebook.uri.scheme,
      authority: notebook.uri.authority,
      path: notebook.uri.path,
      query: notebook.uri.query,
      fragment: `cell-${index}`,
    });

    this.document = {
      uri: cellUri,
      fileName: cellUri.path,
      isUntitled: false,
      languageId: data.languageId,
      version: 1,
      isDirty: false,
      isClosed: false,
      eol: 1, // LF
      lineCount: 1,
      encoding: "utf-8",
      save: () => Promise.resolve(false),
      getText: () => data.value,
      getWordRangeAtPosition: () => undefined,
      validateRange: (range: vscode.Range) => range,
      validatePosition: (position: vscode.Position) => position,
      positionAt: () => new Position(0, 0),
      offsetAt: () => 0,
      lineAt: () => {
        throw new Error("lineAt not implemented");
      },
    };
  }
}

class NotebookDocument implements vscode.NotebookDocument {
  readonly uri: Uri;
  readonly notebookType: string;
  readonly version: number;
  readonly isDirty: boolean;
  readonly isUntitled: boolean;
  readonly metadata: Record<string, unknown>;
  readonly cellCount: number;

  #cells: vscode.NotebookCell[];
  #isClosed = false;

  get isClosed(): boolean {
    return this.#isClosed;
  }

  constructor(notebookType: string, uri: Uri, content?: vscode.NotebookData) {
    this.uri = uri;
    this.notebookType = notebookType;
    this.version = 1;
    this.isDirty = false;
    this.isUntitled = false;
    this.metadata = content?.metadata ?? {};

    const cellData = content?.cells ?? [];
    this.cellCount = cellData.length;
    this.#cells = cellData.map(
      (data, index) => new NotebookCell(this, data, index),
    );
  }

  cellAt(index: number): vscode.NotebookCell {
    if (index < 0 || index >= this.#cells.length) {
      throw new Error(`Cell index ${index} out of bounds`);
    }
    return this.#cells[index];
  }

  getCells(range?: vscode.NotebookRange): vscode.NotebookCell[] {
    if (!range) {
      return this.#cells;
    }
    return this.#cells.slice(range.start, range.end);
  }

  save() {
    return Promise.resolve(true);
  }

  close() {
    this.#isClosed = true;
  }
}

function closeNotebookDocument(document: vscode.NotebookDocument) {
  if (document instanceof NotebookDocument) {
    document.close();
  }
}

export function createNotebookCell(
  notebook: vscode.NotebookDocument,
  data: vscode.NotebookCellData,
  index: number,
): vscode.NotebookCell {
  return new NotebookCell(notebook, data, index);
}

class NotebookEditor implements vscode.NotebookEditor {
  readonly notebook: vscode.NotebookDocument;
  readonly visibleRanges: vscode.NotebookRange[];
  readonly selection: vscode.NotebookRange;
  readonly selections: vscode.NotebookRange[];
  readonly viewColumn: vscode.ViewColumn | undefined;
  readonly revealRange: (range: vscode.NotebookRange) => Promise<void>;

  constructor(notebook: vscode.NotebookDocument) {
    this.notebook = notebook;
    this.visibleRanges = [];
    this.selection = new NotebookRange(0, 0);
    this.selections = [];
    this.viewColumn = undefined;
    this.revealRange = () => Promise.resolve();
  }
}

class CompletionItem implements vscode.CompletionItem {
  label: string | vscode.CompletionItemLabel;
  kind?: vscode.CompletionItemKind;
  tags?: readonly vscode.CompletionItemTag[];
  detail?: string;
  documentation?: string | vscode.MarkdownString;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  insertText?: string | vscode.SnippetString;
  range?: Range | { inserting: vscode.Range; replacing: vscode.Range };
  commitCharacters?: string[];
  keepWhitespace?: boolean;
  textEdit?: vscode.TextEdit;
  additionalTextEdits?: vscode.TextEdit[];
  command?: vscode.Command;
  constructor(
    label: string | vscode.CompletionItemLabel,
    kind?: vscode.CompletionItemKind,
  ) {
    this.label = label;
    this.kind = kind;
  }
}

class CompletionList<
  T extends CompletionItem = CompletionItem,
> implements vscode.CompletionList<T> {
  isIncomplete: boolean;
  items: T[];
  constructor(items: T[], isIncomplete = false) {
    this.items = items;
    this.isIncomplete = isIncomplete;
  }
}

class Location implements vscode.Location {
  uri: Uri;
  range: vscode.Range;
  constructor(uri: Uri, range: vscode.Range) {
    this.uri = uri;
    this.range = range;
  }
}
/**
 * A hover represents additional information for a symbol or word. Hovers are
 * rendered in a tooltip-like widget.
 */
class Hover implements vscode.Hover {
  contents: Array<MarkdownString | vscode.MarkedString>;
  range?: Range;
  constructor(
    contents:
      | MarkdownString
      | vscode.MarkedString
      | Array<MarkdownString | vscode.MarkedString>,
    range?: Range,
  ) {
    this.contents = Array.isArray(contents) ? contents : [contents];
    this.range = range;
  }
}

class DocumentHighlight implements vscode.DocumentHighlight {
  range: Range;
  kind?: vscode.DocumentHighlightKind;
  constructor(range: Range, kind?: vscode.DocumentHighlightKind) {
    this.range = range;
    this.kind = kind;
  }
}

class DocumentSymbol implements vscode.DocumentSymbol {
  name: string;
  detail: string;
  kind: vscode.SymbolKind;
  tags?: readonly vscode.SymbolTag[];
  range: Range;
  selectionRange: Range;
  children: DocumentSymbol[] = [];
  constructor(
    name: string,
    detail: string,
    kind: vscode.SymbolKind,
    range: Range,
    selectionRange: Range,
  ) {
    this.name = name;
    this.detail = detail;
    this.kind = kind;
    this.range = range;
    this.selectionRange = selectionRange;
  }
}

class FoldingRange implements vscode.FoldingRange {
  start: number;
  end: number;
  kind?: vscode.FoldingRangeKind;
  constructor(start: number, end: number, kind?: vscode.FoldingRangeKind) {
    this.start = start;
    this.end = end;
    this.kind = kind;
  }
}

class SelectionRange implements vscode.SelectionRange {
  range: Range;
  parent?: SelectionRange;
  constructor(range: Range, parent?: SelectionRange) {
    this.range = range;
    this.parent = parent;
  }
}

class CodeActionKind {
  readonly value: string;
  private constructor(value: string) {
    this.value = value;
  }
  static readonly Empty = new CodeActionKind("");
  static readonly QuickFix = new CodeActionKind("quickfix");
  static readonly Refactor = new CodeActionKind("refactor");
  static readonly Source = new CodeActionKind("source");
  static readonly RefactorExtract = new CodeActionKind("refactor.extract");
  static readonly RefactorInline = new CodeActionKind("refactor.inline");
  static readonly RefactorMove = new CodeActionKind("refactor.move");
  static readonly RefactorRewrite = new CodeActionKind("refactor.rewrite");
  static readonly SourceFixAll = new CodeActionKind("source.fixAll");
  static readonly SourceOrganizeImports = new CodeActionKind(
    "source.organizeImports",
  );
  static readonly Notebook = new CodeActionKind("notebook");
  append(part: string): CodeActionKind {
    const value = this.value ? `${this.value}.${part}` : part;
    return new CodeActionKind(value);
  }
  intersects(other: CodeActionKind): boolean {
    return this.contains(other) || other.contains(this);
  }
  contains(other: CodeActionKind): boolean {
    return (
      other.value === this.value || other.value.startsWith(`${this.value}.`)
    );
  }
}

class CodeAction {
  title: string;
  edit?: WorkspaceEdit;
  diagnostics?: Diagnostic[];
  command?: vscode.Command;
  kind?: CodeActionKind;
  isPreferred?: boolean;
  disabled?: { readonly reason: string };
  constructor(title: string, kind?: CodeActionKind) {
    this.title = title;
    this.kind = kind;
  }
}

class SnippetString implements vscode.SnippetString {
  value: string;
  constructor(value?: string) {
    this.value = value ?? "";
  }
  appendText(): SnippetString {
    return this;
  }
  appendTabstop(): SnippetString {
    return this;
  }
  appendPlaceholder(): SnippetString {
    return this;
  }
  appendChoice(): SnippetString {
    return this;
  }
  appendVariable(): SnippetString {
    return this;
  }
}

class InlayHintLabelPart implements vscode.InlayHintLabelPart {
  value: string;
  tooltip?: string | MarkdownString;
  location?: Location;
  command?: vscode.Command;
  constructor(value: string) {
    this.value = value;
  }
}

class InlayHint implements vscode.InlayHint {
  position: Position;
  label: string | InlayHintLabelPart[];
  kind?: vscode.InlayHintKind;
  textEdits?: TextEdit[];
  tooltip?: string | MarkdownString;
  paddingLeft?: boolean;
  paddingRight?: boolean;
  constructor(
    position: Position,
    label: string | InlayHintLabelPart[],
    kind?: vscode.InlayHintKind,
  ) {
    this.position = position;
    this.label = label;
    this.kind = kind;
  }
}

class SignatureHelp implements vscode.SignatureHelp {
  signatures: SignatureInformation[] = [];
  activeSignature = 0;
  activeParameter = 0;
}

class SignatureInformation implements vscode.SignatureInformation {
  label: string;
  documentation?: string | MarkdownString;
  parameters: vscode.ParameterInformation[];
  activeParameter?: number;
  constructor(label: string, documentation?: string | MarkdownString) {
    this.label = label;
    this.documentation = documentation;
    this.parameters = [];
  }
}

class ParameterInformation implements vscode.ParameterInformation {
  label: string | [number, number];
  documentation?: string | MarkdownString;
  constructor(
    label: string | [number, number],
    documentation?: string | MarkdownString,
  ) {
    this.label = label;
    this.documentation = documentation;
  }
}

class Diagnostic implements vscode.Diagnostic {
  range: Range;
  message: string;
  severity: vscode.DiagnosticSeverity;
  source?: string;
  code?: string | number | { value: string | number; target: vscode.Uri };
  relatedInformation?: vscode.DiagnosticRelatedInformation[];
  tags?: vscode.DiagnosticTag[];

  constructor(
    range: Range,
    message: string,
    severity?: vscode.DiagnosticSeverity,
  ) {
    this.range = range;
    this.message = message;
    this.severity = severity ?? 0; // Error
  }
}

class DiagnosticCollection implements vscode.DiagnosticCollection {
  readonly name: string;
  private store = new Map<string, vscode.Diagnostic[]>();

  constructor(name: string) {
    this.name = name;
  }

  set(uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[]): void;
  set(entries: ReadonlyArray<[vscode.Uri, readonly vscode.Diagnostic[]]>): void;
  set(
    uriOrEntries:
      | vscode.Uri
      | ReadonlyArray<[vscode.Uri, readonly vscode.Diagnostic[]]>,
    diagnostics?: readonly vscode.Diagnostic[],
  ): void {
    if ("path" in uriOrEntries) {
      const key = uriOrEntries.toString();
      this.store.set(key, diagnostics ? [...diagnostics] : []);
    } else {
      for (const [uri, diags] of uriOrEntries) {
        this.store.set(uri.toString(), [...diags]);
      }
    }
  }

  delete(uri: vscode.Uri): void {
    this.store.delete(uri.toString());
  }

  clear(): void {
    this.store.clear();
  }

  get(uri: vscode.Uri): readonly vscode.Diagnostic[] {
    return this.store.get(uri.toString()) ?? [];
  }

  has(uri: vscode.Uri): boolean {
    return this.store.has(uri.toString());
  }

  forEach(
    callback: (
      uri: vscode.Uri,
      diagnostics: readonly vscode.Diagnostic[],
      collection: vscode.DiagnosticCollection,
    ) => void,
  ): void {
    for (const [uriStr, diags] of this.store) {
      callback(Uri.parse(uriStr), diags, this);
    }
  }

  *[Symbol.iterator](): Iterator<[vscode.Uri, readonly vscode.Diagnostic[]]> {
    for (const [uriStr, diags] of this.store) {
      yield [Uri.parse(uriStr), diags];
    }
  }

  dispose(): void {
    this.store.clear();
  }
}

export function createTestNotebookDocument(
  uri: Uri | string,
  options: {
    data?: vscode.NotebookData;
    notebookType?: string;
  } = {},
): vscode.NotebookDocument {
  if (typeof uri === "string") {
    uri = Uri.file(uri);
  }
  return new NotebookDocument(
    options.notebookType ?? NOTEBOOK_TYPE,
    uri,
    options.data,
  );
}

export function createTestNotebookEditor(
  notebook: vscode.NotebookDocument,
): vscode.NotebookEditor {
  return new NotebookEditor(notebook);
}

export interface NotebookEditorOptions {
  readonly data?: NotebookData;
  readonly notebookType?: string;
}

export interface Options {
  readonly initialDocuments?: Array<vscode.NotebookDocument>;
  readonly initialActiveNotebookEditor?: Option.Option<vscode.NotebookEditor>;
  readonly initialActiveTextEditor?: Option.Option<vscode.TextEditor>;
  readonly visibleNotebookEditors?: Array<vscode.NotebookEditor>;
  readonly version?: string;
  readonly fileSystem?: Map<string, Uint8Array | Error>;
  readonly window?: Partial<Window.Interface>;
  readonly commands?: Partial<Commands.Interface>;
  readonly workspace?: Partial<Workspace.Interface>;
  readonly env?: Partial<Env.Interface>;
  readonly installedExtensions?: ReadonlyArray<string>;
}

export interface CommandExecution {
  readonly command: string;
  readonly args: ReadonlyArray<unknown>;
}

export interface AffinityUpdate {
  readonly controllerId: string;
  readonly notebookUri: string;
  readonly affinity: vscode.NotebookControllerAffinity;
}

export interface RegisteredSerializer {
  readonly notebookType: string;
  readonly serializer: vscode.NotebookSerializer;
  readonly options: vscode.NotebookDocumentContentOptions | undefined;
}

export interface RegisteredStatusBarProvider {
  readonly notebookType: string;
  readonly provideCellStatusBarItems: (
    cell: vscode.NotebookCell,
  ) => Effect.Effect<vscode.NotebookCellStatusBarItem[]>;
}

export interface QuickPickItem {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
}

export interface QuickPickRequest {
  readonly items: ReadonlyArray<QuickPickItem>;
  readonly title: string | undefined;
  readonly canPickMany: boolean;
}

type QuickPickResponse = Data.TaggedEnum<{
  Single: { readonly label: string };
  Many: { readonly labels: ReadonlyArray<string> };
}>;
const QuickPickResponse = Data.taggedEnum<QuickPickResponse>();

export interface Snapshot {
  readonly views: ReadonlyArray<string>;
  readonly commands: ReadonlyArray<string>;
  readonly serializers: ReadonlyArray<string>;
  readonly controllers: ReadonlyArray<string>;
  readonly executions: ReadonlyArray<CommandExecution>;
  readonly affinityUpdates: ReadonlyArray<AffinityUpdate>;
  readonly openedExternalUris: ReadonlyArray<string>;
  readonly workspaceEdits: ReadonlyArray<vscode.WorkspaceEdit>;
  readonly openNotebookUris: ReadonlyArray<string>;
  readonly activeNotebookUri: Option.Option<string>;
  readonly visibleNotebookUris: ReadonlyArray<string>;
  readonly quickPicks: ReadonlyArray<QuickPickRequest>;
  readonly informationMessages: ReadonlyArray<string>;
  readonly warningMessages: ReadonlyArray<string>;
  readonly errorMessages: ReadonlyArray<string>;
}

export interface Interface {
  readonly snapshot: Effect.Effect<Snapshot>;
  readonly controllers: Effect.Effect<ReadonlyArray<vscode.NotebookController>>;
  readonly controllerChanges: Stream.Stream<
    ReadonlyArray<vscode.NotebookController>
  >;
  readonly affinityChanges: Stream.Stream<ReadonlyArray<AffinityUpdate>>;
  readonly serializers: Effect.Effect<ReadonlyArray<RegisteredSerializer>>;
  readonly statusBarProviders: Effect.Effect<
    ReadonlyArray<RegisteredStatusBarProvider>
  >;
  readonly openNotebook: (
    document: vscode.NotebookDocument,
  ) => Effect.Effect<void>;
  readonly closeNotebook: (
    document: vscode.NotebookDocument,
  ) => Effect.Effect<void>;
  readonly notebookChange: (
    event: vscode.NotebookDocumentChangeEvent,
  ) => Effect.Effect<boolean>;
  readonly setActiveNotebookEditor: (
    editor: Option.Option<vscode.NotebookEditor>,
  ) => Effect.Effect<void>;
  readonly setActiveTextEditor: (
    editor: Option.Option<vscode.TextEditor>,
  ) => Effect.Effect<void>;
  readonly selectQuickPick: (label: string) => Effect.Effect<void>;
  readonly selectQuickPickMany: (
    labels: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
  readonly selectInformationMessage: (item: string) => Effect.Effect<void>;
  readonly configurationChange: (
    event: vscode.ConfigurationChangeEvent,
  ) => Effect.Effect<void>;
  readonly awaitExecutions: (
    predicate: (executions: ReadonlyArray<CommandExecution>) => boolean,
  ) => Effect.Effect<void>;
  readonly awaitInformationMessages: (count: number) => Effect.Effect<void>;
  readonly selectNotebookController: (
    controllerId: string,
    notebook: vscode.NotebookDocument,
    selected: boolean,
  ) => Effect.Effect<void>;
  readonly rendererMessaging: {
    readonly ready: Effect.Effect<void>;
    readonly send: (
      editor: vscode.NotebookEditor,
      message: RendererCommand,
    ) => Effect.Effect<void>;
    readonly receive: Effect.Effect<RendererReceiveMessage>;
  };
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/VsCode",
) {}

export class TestVsCode extends Data.TaggedClass("TestVsCode")<{
  readonly layer: Layer.Layer<VsCode.Service | Service>;
  readonly views: Ref.Ref<HashSet.HashSet<string>>;
  readonly commands: Ref.Ref<HashSet.HashSet<string>>;
  readonly controllers: SubscriptionRef.SubscriptionRef<
    HashSet.HashSet<vscode.NotebookController>
  >;
  readonly executions: Ref.Ref<ReadonlyArray<CommandExecution>>;
  readonly serializers: Ref.Ref<HashSet.HashSet<RegisteredSerializer>>;
  readonly statusBarProviders: Ref.Ref<Array<RegisteredStatusBarProvider>>;
  readonly documentChangesPubSub: PubSub.PubSub<vscode.NotebookDocumentChangeEvent>;
  readonly documentOpenedPubSub: PubSub.PubSub<vscode.NotebookDocument>;
  readonly documentClosedPubSub: PubSub.PubSub<vscode.NotebookDocument>;
  readonly documentLifecyclePubSub: PubSub.PubSub<Workspace.NotebookLifecycleEvent>;
  readonly setActiveNotebookEditor: (
    editor: Option.Option<vscode.NotebookEditor>,
  ) => Effect.Effect<void>;
  readonly selectNotebookController: (
    controllerId: string,
    notebook: vscode.NotebookDocument,
    selected: boolean,
  ) => Effect.Effect<void>;
  readonly rendererMessaging: {
    readonly ready: Effect.Effect<void>;
    readonly send: (
      editor: vscode.NotebookEditor,
      message: RendererCommand,
    ) => Effect.Effect<void>;
    readonly receive: Effect.Effect<RendererReceiveMessage>;
  };
  readonly setActiveTextEditor: (
    editor: Option.Option<vscode.TextEditor>,
  ) => Effect.Effect<void>;
  readonly addNotebookDocument: (
    doc: vscode.NotebookDocument,
  ) => Effect.Effect<void>;
  readonly removeNotebookDocument: (
    doc: vscode.NotebookDocument,
  ) => Effect.Effect<void>;
  readonly affinityUpdates: SubscriptionRef.SubscriptionRef<
    ReadonlyArray<AffinityUpdate>
  >;
}> {
  static makeNotebookEditor(
    uri: string | Uri,
    options: NotebookEditorOptions = {},
  ) {
    return createTestNotebookEditor(createTestNotebookDocument(uri, options));
  }
  snapshot() {
    return Effect.gen({ self: this }, function* () {
      return {
        views: yield* Effect.map(Ref.get(this.views), (map) =>
          Array.from(map).toSorted(),
        ),
        commands: yield* Effect.map(Ref.get(this.commands), (map) =>
          Array.from(map).toSorted(),
        ),
        serializers: yield* Effect.map(Ref.get(this.serializers), (map) =>
          Array.from(map)
            .map((s) => s.notebookType)
            .toSorted(),
        ),
        controllers: yield* Effect.map(
          SubscriptionRef.get(this.controllers),
          (map) =>
            Array.from(map)
              .map((c) => c.id)
              .toSorted(),
        ),
      };
    });
  }

  getAffinityUpdates() {
    return SubscriptionRef.get(this.affinityUpdates);
  }

  createMockUri(path: string): Uri {
    return Uri.from({
      scheme: "file",
      authority: "",
      path,
    });
  }

  getRegisteredStatusBarItemProviders() {
    return Ref.get(this.statusBarProviders);
  }

  notebookChange(event: vscode.NotebookDocumentChangeEvent) {
    return PubSub.publish(this.documentChangesPubSub, event);
  }

  openNotebook(doc: vscode.NotebookDocument) {
    return this.addNotebookDocument(doc).pipe(
      Effect.andThen(PubSub.publish(this.documentOpenedPubSub, doc)),
      Effect.andThen(
        PubSub.publish(this.documentLifecyclePubSub, {
          type: "opened" as const,
          document: doc,
        }),
      ),
    );
  }

  closeNotebook(doc: vscode.NotebookDocument) {
    return Effect.sync(() => closeNotebookDocument(doc)).pipe(
      // VS Code marks a document closed before firing onDidCloseNotebookDocument.
      Effect.andThen(this.removeNotebookDocument(doc)),
      Effect.andThen(PubSub.publish(this.documentClosedPubSub, doc)),
      Effect.andThen(
        PubSub.publish(this.documentLifecyclePubSub, {
          type: "closed" as const,
          document: doc,
        }),
      ),
    );
  }

  static make = Effect.fn(function* (options: Options = {}) {
    const activeTextEditor = yield* SubscriptionRef.make(
      options.initialActiveTextEditor ?? Option.none<vscode.TextEditor>(),
    );
    const activeNotebookEditor = yield* SubscriptionRef.make(
      options.initialActiveNotebookEditor ??
        Option.none<vscode.NotebookEditor>(),
    );

    const visibleNotebookEditors = yield* SubscriptionRef.make(
      options.visibleNotebookEditors ?? [],
    );

    const visibleTextEditors = yield* SubscriptionRef.make(
      [] as ReadonlyArray<vscode.TextEditor>,
    );

    const notebookDocuments = yield* Ref.make(
      HashSet.make(...(options.initialDocuments ?? [])),
    );

    const documentChanges =
      yield* PubSub.unbounded<vscode.NotebookDocumentChangeEvent>();

    const documentOpened = yield* PubSub.unbounded<vscode.NotebookDocument>();

    const documentClosed = yield* PubSub.unbounded<vscode.NotebookDocument>();

    const documentLifecycle =
      yield* PubSub.unbounded<Workspace.NotebookLifecycleEvent>();

    const commands = yield* Ref.make(HashSet.empty<string>());
    const controllers = yield* SubscriptionRef.make(
      HashSet.empty<vscode.NotebookController>(),
    );
    const controllerSelectionEmitters = new Map<
      string,
      EventEmitter<{
        notebook: vscode.NotebookDocument;
        selected: boolean;
      }>
    >();
    const rendererMessages = new EventEmitter<{
      editor: vscode.NotebookEditor;
      message: RendererCommand;
    }>();
    const rendererMessagingReady = yield* Deferred.make<void>();
    const rendererReplies = yield* Queue.unbounded<RendererReceiveMessage>();
    const serializers = yield* Ref.make(
      HashSet.empty<{
        notebookType: string;
        serializer: vscode.NotebookSerializer;
        options: vscode.NotebookDocumentContentOptions | undefined;
      }>(),
    );
    const statusBarProviders = yield* Ref.make<
      Array<{
        notebookType: string;
        provideCellStatusBarItems(
          cell: vscode.NotebookCell,
        ): Effect.Effect<vscode.NotebookCellStatusBarItem[]>;
      }>
    >([]);
    const views = yield* Ref.make(HashSet.empty<string>());

    const executions = yield* Ref.make<ReadonlyArray<CommandExecution>>([]);
    const executionRevision = yield* SubscriptionRef.make(0);

    const affinityUpdates = yield* SubscriptionRef.make<
      ReadonlyArray<AffinityUpdate>
    >([]);
    const openedExternalUris = yield* Ref.make<ReadonlyArray<string>>([]);
    const workspaceEdits = yield* Ref.make<ReadonlyArray<vscode.WorkspaceEdit>>(
      [],
    );
    const quickPicks = yield* Ref.make<ReadonlyArray<QuickPickRequest>>([]);
    const quickPickResponses = yield* Queue.unbounded<QuickPickResponse>();
    const informationMessages = yield* Ref.make<ReadonlyArray<string>>([]);
    const informationMessageRevision = yield* SubscriptionRef.make(0);
    const warningMessages = yield* Ref.make<ReadonlyArray<string>>([]);
    const errorMessages = yield* Ref.make<ReadonlyArray<string>>([]);
    const informationMessageResponses = yield* Queue.unbounded<string>();
    const configurationChanges =
      yield* PubSub.unbounded<vscode.ConfigurationChangeEvent>();

    const recordQuickPick = (
      items: ReadonlyArray<QuickPickItem>,
      title: string | undefined,
      canPickMany: boolean,
    ) =>
      Ref.update(quickPicks, (requests) => [
        ...requests,
        {
          items: items.map((item) => ({
            label: item.label,
            description: item.description,
            detail: item.detail,
          })),
          title,
          canPickMany,
        },
      ]);

    const takeQuickPickResponse = Queue.poll(quickPickResponses);

    const selectQuickPickItem = <T extends QuickPickItem>(
      items: ReadonlyArray<T>,
      title: string | undefined,
    ) =>
      Effect.gen(function* () {
        yield* recordQuickPick(items, title, false);
        const response = yield* takeQuickPickResponse;
        if (Option.isNone(response)) return Option.none<T>();
        const value = response.value;
        if (value._tag !== "Single") {
          return yield* Effect.die(
            "Expected a single-item quick-pick response",
          );
        }
        const selected = items.find((item) => item.label === value.label);
        if (selected === undefined) {
          return yield* Effect.die(`Quick-pick item not found: ${value.label}`);
        }
        return Option.some(selected);
      });

    const selectQuickPickItems = <T extends QuickPickItem>(
      items: ReadonlyArray<T>,
      title: string | undefined,
    ) =>
      Effect.gen(function* () {
        yield* recordQuickPick(items, title, true);
        const response = yield* takeQuickPickResponse;
        if (Option.isNone(response)) return Option.none<ReadonlyArray<T>>();
        if (response.value._tag !== "Many") {
          return yield* Effect.die("Expected a multi-item quick-pick response");
        }
        const selected: T[] = [];
        for (const label of response.value.labels) {
          const item = items.find((candidate) => candidate.label === label);
          if (item === undefined) {
            return yield* Effect.die(`Quick-pick item not found: ${label}`);
          }
          selected.push(item);
        }
        return Option.some(selected);
      });

    const context = yield* Effect.context();

    const commandResultsPubSub =
      yield* PubSub.unbounded<Result.Result<string, string>>();

    const layer = Layer.succeed(VsCode.Service, {
      // namespaces
      window: {
        showSaveDialog() {
          return Effect.succeed(Option.none());
        },
        showInputBox:
          options.window?.showInputBox ?? (() => Effect.succeed(Option.none())),
        showInformationMessage:
          options.window?.showInformationMessage ??
          ((message, options = {}) =>
            Ref.update(informationMessages, (messages) => [
              ...messages,
              message,
            ]).pipe(
              Effect.andThen(
                SubscriptionRef.update(
                  informationMessageRevision,
                  (revision) => revision + 1,
                ),
              ),
              Effect.andThen(Queue.poll(informationMessageResponses)),
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.succeed(Option.none()),
                  onSome: (selected) => {
                    const item = options.items?.find(
                      (candidate) => candidate === selected,
                    );
                    return item === undefined
                      ? Effect.die(
                          `Information-message item not found: ${selected}`,
                        )
                      : Effect.succeed(Option.some(item));
                  },
                }),
              ),
            )),
        showWarningMessage:
          options.window?.showWarningMessage ??
          ((message) =>
            Ref.update(warningMessages, (messages) => [
              ...messages,
              message,
            ]).pipe(Effect.as(Option.none()))),
        showErrorMessage:
          options.window?.showErrorMessage ??
          ((message) =>
            Ref.update(errorMessages, (messages) => [
              ...messages,
              message,
            ]).pipe(Effect.as(Option.none()))),
        showQuickPick:
          options.window?.showQuickPick ??
          ((items, options) =>
            selectQuickPickItem(
              items.map((label) => ({ label })),
              options?.title,
            ).pipe(Effect.map(Option.map((item) => item.label)))),
        showQuickPickItems(items, options) {
          return selectQuickPickItem(items, options?.title);
        },
        showQuickPickItemsMany(items, options) {
          return selectQuickPickItems(items, options?.title);
        },
        createOutputChannel(name) {
          return Effect.succeed({
            name,
            dispose() {},
            append() {},
            appendLine() {},
            replace() {},
            clear() {},
            show() {},
            hide() {},
          });
        },
        createTerminal() {
          return Effect.succeed({
            sendText() {},
            show() {},
          });
        },
        createLogOutputChannel(name) {
          return acquireDisposable(() => {
            const emitter = new EventEmitter<vscode.LogLevel>();
            return {
              name,
              logLevel: 0,
              onDidChangeLogLevel: emitter.event,
              dispose() {
                emitter.dispose();
              },
              append() {},
              appendLine() {},
              replace() {},
              clear() {},
              show() {},
              hide() {},
              trace() {},
              debug() {},
              info() {},
              warn() {},
              error() {},
            };
          });
        },
        getVisibleNotebookEditors: SubscriptionRef.get(visibleNotebookEditors),
        getVisibleTextEditors: SubscriptionRef.get(visibleTextEditors),
        getActiveNotebookEditor: SubscriptionRef.get(activeNotebookEditor),
        activeNotebookEditorChanges:
          SubscriptionRef.changes(activeNotebookEditor),
        visibleNotebookEditorsChanges: SubscriptionRef.changes(
          visibleNotebookEditors,
        ),
        visibleTextEditorsChanges: SubscriptionRef.changes(visibleTextEditors),
        getActiveTextEditor: SubscriptionRef.get(activeTextEditor),
        // VS Code emits future active-editor changes; it does not replay the
        // editor returned by `getActiveTextEditor` when a listener subscribes.
        activeTextEditorChanges: SubscriptionRef.changes(activeTextEditor).pipe(
          Stream.drop(1),
        ),
        colorThemeChanges:
          options.window?.colorThemeChanges ?? Stream.make("light" as const),
        closeTextEditorTab: () => Effect.void,
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-type-parameters
        createTreeView<T>(viewId: string) {
          return Effect.acquireRelease(
            Effect.gen(function* () {
              yield* Ref.update(views, HashSet.add(viewId));
              const expandElement = new EventEmitter<
                vscode.TreeViewExpansionEvent<T>
              >();
              const collapseElement = new EventEmitter<
                vscode.TreeViewExpansionEvent<T>
              >();
              const changeSelection = new EventEmitter<
                vscode.TreeViewSelectionChangeEvent<T>
              >();
              const changeVisibility =
                new EventEmitter<vscode.TreeViewVisibilityChangeEvent>();
              const changeCheckboxState = new EventEmitter<
                vscode.TreeCheckboxChangeEvent<T>
              >();
              return {
                onDidExpandElement: expandElement.event,
                onDidCollapseElement: collapseElement.event,
                selection: [],
                onDidChangeSelection: changeSelection.event,
                visible: false,
                onDidChangeVisibility: changeVisibility.event,
                onDidChangeCheckboxState: changeCheckboxState.event,
                async reveal(): Promise<void> {},
                dispose() {
                  expandElement.dispose();
                  collapseElement.dispose();
                  changeSelection.dispose();
                  changeVisibility.dispose();
                  changeCheckboxState.dispose();
                },
              };
            }),
            (disposable) =>
              Effect.gen(function* () {
                yield* Ref.update(views, HashSet.remove(viewId));
                yield* Effect.sync(() => disposable.dispose());
              }),
          );
        },
        createStatusBarItem(
          id: string,
          alignment: vscode.StatusBarAlignment,
          priority?: number,
        ) {
          return acquireDisposable(() => ({
            id,
            alignment,
            priority,
            text: "",
            name: undefined,
            tooltip: undefined,
            color: undefined,
            backgroundColor: undefined,
            command: undefined,
            accessibilityInformation: undefined,
            show() {},
            hide() {},
            dispose() {},
          }));
        },
        showNotebookDocument(
          doc: vscode.NotebookDocument,
          options?: vscode.NotebookDocumentShowOptions,
        ) {
          return Effect.succeed({
            notebook: doc,
            visibleRanges: [],
            selection: new NotebookRange(0, 0),
            selections: options?.selections ?? [],
            viewColumn: options?.viewColumn,
            revealRange() {},
          });
        },
        showTextDocument() {
          return Effect.void;
        },
        withProgress(_options, fn) {
          return Effect.orDie(fn({ report() {} }));
        },
        ...options.window,
      },
      commands: {
        subscribeToCommands: PubSub.subscribe(commandResultsPubSub),
        setContext(key, value) {
          return Ref.update(executions, (arr) => [
            ...arr,
            { command: "setContext", args: [key, value] },
          ]).pipe(
            Effect.andThen(
              SubscriptionRef.update(
                executionRevision,
                (revision) => revision + 1,
              ),
            ),
          );
        },
        execute(command, ...args) {
          return Ref.update(executions, (arr) => [
            ...arr,
            { command: commandId(command), args },
          ]).pipe(
            Effect.andThen(
              SubscriptionRef.update(
                executionRevision,
                (revision) => revision + 1,
              ),
            ),
            Effect.andThen(decodeCommandResult(command, undefined)),
          );
        },
        executeVSCode(command, ...args) {
          return Ref.update(executions, (arr) => [
            ...arr,
            { command, args },
          ]).pipe(
            Effect.andThen(
              SubscriptionRef.update(
                executionRevision,
                (revision) => revision + 1,
              ),
            ),
          );
        },
        bind(command, title, ...args) {
          return {
            command: commandId(command),
            title,
            arguments: [...args],
          };
        },
        register(definition) {
          const name = commandId(definition.command);
          return Effect.gen(function* () {
            yield* Ref.update(commands, HashSet.add<string>(name));
            yield* Effect.addFinalizer(() =>
              Ref.update(commands, HashSet.remove<string>(name)),
            );
          });
        },
        ...options.commands,
      },
      workspace: {
        fs: {
          createDirectory() {
            return Effect.void;
          },
          readFile(uri: vscode.Uri) {
            const fileSystem: Map<string, Uint8Array | Error> =
              options.fileSystem ?? new Map();

            const key = uri.toString();
            const entry = fileSystem.get(key);

            if (entry instanceof Error) {
              return Effect.fail(
                new Workspace.FileSystemError({ cause: entry }),
              );
            }

            if (entry !== undefined) {
              return Effect.succeed(entry);
            }

            // File not in map - return error for missing file
            return Effect.fail(
              new Workspace.FileSystemError({
                cause: new Error(`ENOENT: ${key}`),
              }),
            );
          },
          writeFile() {
            return Effect.succeed(true);
          },
        },
        getNotebookDocuments: Effect.map(Ref.get(notebookDocuments), (docs) =>
          Array.from(docs),
        ),
        getTextDocuments: Effect.map(
          SubscriptionRef.get(visibleTextEditors),
          (editors) => editors.map((editor) => editor.document),
        ),
        configurationChanges: Stream.fromPubSub(configurationChanges),
        getConfiguration() {
          return Effect.succeed({
            get: () => undefined,
            has: () => false,
            inspect: () => undefined,
            async update() {},
          });
        },
        getWorkspaceFolders: Effect.succeed(Option.none()),
        isTrusted() {
          return true;
        },
        registerNotebookSerializer(notebookType, impl, options) {
          return Effect.acquireRelease(
            Effect.gen(function* () {
              const serializer = {
                notebookType,
                serializer: impl,
                options: options ?? undefined,
              };
              yield* Ref.update(serializers, HashSet.add(serializer));
              return serializer;
            }),
            (serializer) => Ref.update(serializers, HashSet.remove(serializer)),
          );
        },
        notebookDocumentOpened: Stream.fromPubSub(documentOpened),
        notebookDocumentChanges: Stream.fromPubSub(documentChanges),
        notebookDocumentClosed: Stream.fromPubSub(documentClosed),
        // Mirrors the real implementation's guarantee: the subscription is
        // live and the snapshot captured before the effect completes, so an
        // open or close published afterwards cannot be lost.
        subscribeNotebookLifecycle: Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(documentLifecycle);
          const documents = yield* Ref.get(notebookDocuments);
          return Stream.concat(
            Stream.fromIterable(
              Array.from(documents, (document) => ({
                type: "opened" as const,
                document,
              })),
            ),
            Stream.fromSubscription(subscription),
          );
        }),
        fileRenames: Stream.never,
        fileDeletes: Stream.never,
        textDocumentChanges: Stream.never,
        createFileSystemWatcher() {
          return Stream.never;
        },
        applyEdit(edit) {
          return Ref.update(workspaceEdits, (current) => [
            ...current,
            edit,
          ]).pipe(Effect.as(true));
        },
        openNotebookDocument(uri: vscode.Uri) {
          return Effect.succeed(new NotebookDocument("marimo-notebook", uri));
        },
        openUntitledNotebookDocument(
          notebookType: string,
          content?: vscode.NotebookData,
        ) {
          return Effect.succeed(
            new NotebookDocument(
              notebookType,
              Uri.file("/mocks/foo.py"),
              content,
            ),
          );
        },
        openUntitledTextDocument(options: {
          content?: string;
          language?: string;
        }) {
          const version = 1;
          return Effect.succeed(
            new TextDocument(
              Uri.file("/mocks/foo.txt"),
              options.language ?? "plaintext",
              version,
              options.content ?? "",
            ),
          );
        },
        ...options.workspace,
      },
      env: {
        appName: "Marimo Test",
        appRoot: "/mocks",
        appHost: "desktop",
        machineId: "mock-machine-id",
        createTelemetryLogger(sender, loggerOptions) {
          const withCommon = (data: Record<string, unknown> = {}) => ({
            ...data,
            ...loggerOptions?.additionalCommonProperties,
          });
          return acquireDisposable(() => ({
            isUsageEnabled: true,
            isErrorsEnabled: true,
            onDidChangeEnableStates: () => ({ dispose() {} }),
            logUsage(eventName, data) {
              sender.sendEventData(eventName, withCommon(data));
            },
            logError(eventNameOrError, data) {
              if (typeof eventNameOrError === "string") {
                sender.sendEventData(eventNameOrError, withCommon(data));
              } else {
                sender.sendErrorData(eventNameOrError, withCommon(data));
              }
            },
            dispose() {},
          }));
        },
        openExternal(uri) {
          return Ref.update(openedExternalUris, (current) => [
            ...current,
            uri.toString(true),
          ]).pipe(Effect.as(true));
        },
        ...options.env,
      },
      debug: {
        registerDebugConfigurationProvider() {
          return Effect.acquireRelease(Effect.void, () => Effect.void);
        },
        registerDebugAdapterDescriptorFactory() {
          return Effect.acquireRelease(Effect.void, () => Effect.void);
        },
        startDebugging() {
          return Effect.succeed(true);
        },
        stopDebugging(_sessionId?: string) {
          return Effect.void;
        },
        onDidTerminateDebugSession() {
          return Effect.acquireRelease(Effect.void, () => Effect.void);
        },
      },
      notebooks: {
        createNotebookController(id, notebookType, label) {
          return Effect.acquireRelease(
            Effect.gen(function* () {
              const emitter = new EventEmitter();
              const controller: vscode.NotebookController = {
                id,
                notebookType,
                label,
                onDidChangeSelectedNotebooks: emitter.event,
                dispose: () => emitter.dispose(),
                createNotebookCellExecution() {
                  return {
                    start() {},
                    end() {},
                    async appendOutput() {},
                    async clearOutput() {},
                    async appendOutputItems() {},
                    executionOrder: undefined,
                    token: {
                      isCancellationRequested: false,
                      onCancellationRequested() {
                        return { dispose: () => {} };
                      },
                    },
                    async replaceOutput() {},
                    async replaceOutputItems() {},
                    get cell(): vscode.NotebookCell {
                      throw new Error(
                        "CellExecution.cell not implemented in TestVsCode.",
                      );
                    },
                  };
                },
                executeHandler() {},
                updateNotebookAffinity(
                  notebook: vscode.NotebookDocument,
                  affinity: vscode.NotebookControllerAffinity,
                ) {
                  Effect.runSyncWith(context)(
                    SubscriptionRef.update(affinityUpdates, (updates) => [
                      ...updates,
                      {
                        controllerId: id,
                        notebookUri: notebook.uri.toString(),
                        affinity,
                      },
                    ]),
                  );
                },
              };
              controllerSelectionEmitters.set(id, emitter);
              yield* SubscriptionRef.update(
                controllers,
                HashSet.add(controller),
              );
              return controller;
            }),
            (controller) =>
              Effect.gen(function* () {
                controllerSelectionEmitters.delete(controller.id);
                yield* Effect.sync(() => controller.dispose());
                yield* SubscriptionRef.update(
                  controllers,
                  HashSet.remove(controller),
                );
              }),
          );
        },
        createRendererMessaging() {
          return Effect.succeed({
            postMessage(message: RendererReceiveMessage) {
              Effect.runSyncWith(context)(
                Queue.offer(rendererReplies, message),
              );
              return Promise.resolve(true);
            },
            onDidReceiveMessage(listener) {
              const disposable = rendererMessages.event(listener);
              Effect.runSyncWith(context)(
                Deferred.succeed(rendererMessagingReady, undefined),
              );
              return disposable;
            },
          });
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
            const registration = {
              notebookType,
              provideCellStatusBarItems: (cell: vscode.NotebookCell) =>
                impl.provideCellStatusBarItems(cell),
            };
            yield* Ref.update(statusBarProviders, (providers) => [
              ...providers,
              registration,
            ]);
            yield* Effect.addFinalizer(() =>
              Ref.update(statusBarProviders, (providers) =>
                providers.filter((p) => p !== registration),
              ),
            );
          });
        },
      },
      auth: {
        getSession() {
          return Effect.succeed(Option.none());
        },
      },
      NotebookData,
      NotebookCellData,
      NotebookCellKind: {
        Markup: 1,
        Code: 2,
      },
      NotebookCellOutput,
      NotebookCellOutputItem,
      NotebookEdit,
      NotebookRange,
      NotebookCellStatusBarItem,
      NotebookCellStatusBarAlignment: {
        Left: 1,
        Right: 2,
      },
      NotebookControllerAffinity: {
        Default: 1,
        Preferred: 2,
      },
      NotebookEditorRevealType: {
        Default: 0,
        InCenter: 1,
        InCenterIfOutsideViewport: 2,
        AtTop: 3,
      },
      WorkspaceEdit,
      EventEmitter,
      // oxlint-disable-next-line no-extraneous-class
      DebugAdapterInlineImplementation: class {},
      ProgressLocation: {
        SourceControl: 1,
        Window: 10,
        Notification: 15,
      },
      ThemeIcon,
      TreeItem,
      TreeItemCollapsibleState: {
        None: 0,
        Collapsed: 1,
        Expanded: 2,
      },
      ThemeColor,
      StatusBarAlignment: {
        Left: 1,
        Right: 2,
      },
      Uri,
      RelativePattern,
      MarkdownString,
      CompletionItem,
      CompletionList,
      Position,
      Range,
      Location,
      Hover,
      TextEdit,
      SignatureHelp,
      InlayHint,
      InlayHintLabelPart,
      SnippetString,
      CodeAction,
      CodeActionKind,
      SignatureInformation,
      ParameterInformation,
      CodeLens,
      DocumentHighlight,
      DocumentSymbol,
      FoldingRange,
      SelectionRange,
      SemanticTokensLegend,
      SemanticTokens,
      CompletionTriggerKind: {
        Invoke: 0,
        TriggerCharacter: 1,
        TriggerForIncompleteCompletions: 2,
      },
      CompletionItemKind: {
        Text: 0,
        Method: 1,
        Function: 2,
        Constructor: 3,
        Field: 4,
        Variable: 5,
        Class: 6,
        Interface: 7,
        Module: 8,
        Property: 9,
        Unit: 10,
        Value: 11,
        Enum: 12,
        Keyword: 13,
        Snippet: 14,
        Color: 15,
        File: 16,
        Reference: 17,
        Folder: 18,
        EnumMember: 19,
        Constant: 20,
        Struct: 21,
        Event: 22,
        Operator: 23,
        TypeParameter: 24,
        User: 25,
        Issue: 26,
      },
      version: options.version ?? "1.86.0",
      extensions: {
        getExtension: <T = unknown>(extensionId: string) =>
          options.installedExtensions?.includes(extensionId)
            ? // Only identity matters to callers here; the rest of the
              // Extension surface is not exercised by tests.
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion
              Option.some({ id: extensionId } as vscode.Extension<T>)
            : Option.none<vscode.Extension<T>>(),
      },
      lm: {
        registerTool: () => Effect.succeed({ dispose: () => {} }),
      },
      LanguageModelToolResult,
      LanguageModelTextPart,
      languages: {
        registerCodeLensProvider: () => Effect.void,
        createDiagnosticCollection: (name: string) =>
          new DiagnosticCollection(name),
        registerHoverProvider: () => Effect.void,
        registerDefinitionProvider: () => Effect.void,
        registerDeclarationProvider: () => Effect.void,
        registerTypeDefinitionProvider: () => Effect.void,
        registerReferenceProvider: () => Effect.void,
        registerDocumentHighlightProvider: () => Effect.void,
        registerDocumentSymbolProvider: () => Effect.void,
        registerFoldingRangeProvider: () => Effect.void,
        registerSelectionRangeProvider: () => Effect.void,
        registerDocumentFormattingEditProvider: () => Effect.void,
        registerDocumentRangeFormattingEditProvider: () => Effect.void,
        registerSignatureHelpProvider: () => Effect.void,
        registerInlayHintsProvider: () => Effect.void,
        registerCompletionItemProvider: () => Effect.void,
        registerCodeActionsProvider: () => Effect.void,
        registerRenameProvider: () => Effect.void,
        registerDocumentSemanticTokensProvider: () => Effect.void,
        registerDocumentRangeSemanticTokensProvider: () => Effect.void,
      },
      Diagnostic,
      DiagnosticSeverity: {
        Error: 0,
        Warning: 1,
        Information: 2,
        Hint: 3,
      },
      CodeActionTriggerKind: {
        Invoke: 1,
        Automatic: 2,
      },
      // helper
      utils: {
        parseUri(value: string) {
          return Result.try({
            try: () => Uri.parse(value, /* strict */ true),
            catch: (cause) => new VsCode.ParseUriError({ cause }),
          });
        },
      },
    });

    const setActiveNotebookEditor: Interface["setActiveNotebookEditor"] = (
      editor,
    ) =>
      Effect.gen(function* () {
        yield* SubscriptionRef.set(activeNotebookEditor, editor);
        // Also update visible editors - when an editor becomes active, it's visible
        if (Option.isSome(editor)) {
          const current = yield* SubscriptionRef.get(visibleNotebookEditors);
          yield* SubscriptionRef.set(visibleNotebookEditors, [
            ...current,
            editor.value,
          ]);
        }
      });

    const selectNotebookController: Interface["selectNotebookController"] = (
      controllerId,
      notebook,
      selected,
    ) =>
      Effect.sync(() => {
        const emitter = controllerSelectionEmitters.get(controllerId);
        if (emitter === undefined) {
          throw new Error(
            `Notebook controller is not registered: ${controllerId}`,
          );
        }
        emitter.fire({ notebook, selected });
      });

    const rendererMessaging: Interface["rendererMessaging"] = {
      ready: Deferred.await(rendererMessagingReady),
      send: (editor, message) =>
        Effect.sync(() => rendererMessages.fire({ editor, message })),
      receive: Queue.take(rendererReplies),
    };

    const setActiveTextEditor: Interface["setActiveTextEditor"] = (editor) =>
      Effect.gen(function* () {
        yield* SubscriptionRef.set(activeTextEditor, editor);
        // Also update visible editors - when an editor becomes active, it's visible
        if (Option.isSome(editor)) {
          const current = yield* SubscriptionRef.get(visibleTextEditors);
          yield* SubscriptionRef.set(visibleTextEditors, [
            ...current,
            editor.value,
          ]);
        }
      });

    const addNotebookDocument = (doc: vscode.NotebookDocument) =>
      Ref.update(notebookDocuments, (docs) => HashSet.add(docs, doc));
    const removeNotebookDocument = (doc: vscode.NotebookDocument) =>
      Ref.update(notebookDocuments, (docs) => HashSet.remove(docs, doc));
    const notebookChange: Interface["notebookChange"] = (event) =>
      PubSub.publish(documentChanges, event);
    const openNotebook: Interface["openNotebook"] = (doc) =>
      addNotebookDocument(doc).pipe(
        Effect.andThen(PubSub.publish(documentOpened, doc)),
        Effect.andThen(
          PubSub.publish(documentLifecycle, {
            type: "opened" as const,
            document: doc,
          }),
        ),
        Effect.asVoid,
      );
    const closeNotebook: Interface["closeNotebook"] = (doc) =>
      Effect.sync(() => closeNotebookDocument(doc)).pipe(
        Effect.andThen(removeNotebookDocument(doc)),
        Effect.andThen(PubSub.publish(documentClosed, doc)),
        Effect.andThen(
          PubSub.publish(documentLifecycle, {
            type: "closed" as const,
            document: doc,
          }),
        ),
        Effect.asVoid,
      );

    const snapshot = Effect.gen(function* () {
      const currentViews = yield* Ref.get(views);
      const currentCommands = yield* Ref.get(commands);
      const currentSerializers = yield* Ref.get(serializers);
      const currentControllers = yield* SubscriptionRef.get(controllers);
      const currentExecutions = yield* Ref.get(executions);
      const currentAffinityUpdates =
        yield* SubscriptionRef.get(affinityUpdates);
      const currentOpenedExternalUris = yield* Ref.get(openedExternalUris);
      const currentWorkspaceEdits = yield* Ref.get(workspaceEdits);
      const currentQuickPicks = yield* Ref.get(quickPicks);
      const currentInformationMessages = yield* Ref.get(informationMessages);
      const currentWarningMessages = yield* Ref.get(warningMessages);
      const currentErrorMessages = yield* Ref.get(errorMessages);
      const currentDocuments = yield* Ref.get(notebookDocuments);
      const currentActiveEditor =
        yield* SubscriptionRef.get(activeNotebookEditor);
      const currentVisibleEditors = yield* SubscriptionRef.get(
        visibleNotebookEditors,
      );

      return {
        views: Array.from(currentViews).toSorted(),
        commands: Array.from(currentCommands).toSorted(),
        serializers: Array.from(
          currentSerializers,
          (entry) => entry.notebookType,
        ).toSorted(),
        controllers: Array.from(
          currentControllers,
          (entry) => entry.id,
        ).toSorted(),
        executions: currentExecutions.map((entry) => ({
          command: entry.command,
          args: [...entry.args],
        })),
        affinityUpdates: currentAffinityUpdates.map((entry) => ({ ...entry })),
        openedExternalUris: [...currentOpenedExternalUris],
        workspaceEdits: [...currentWorkspaceEdits],
        openNotebookUris: Array.from(currentDocuments, (document) =>
          document.uri.toString(),
        ).toSorted(),
        activeNotebookUri: Option.map(currentActiveEditor, (editor) =>
          editor.notebook.uri.toString(),
        ),
        visibleNotebookUris: currentVisibleEditors
          .map((editor) => editor.notebook.uri.toString())
          .toSorted(),
        quickPicks: currentQuickPicks.map((request) => ({
          ...request,
          items: request.items.map((item) => ({ ...item })),
        })),
        informationMessages: [...currentInformationMessages],
        warningMessages: [...currentWarningMessages],
        errorMessages: [...currentErrorMessages],
      } satisfies Snapshot;
    });

    const testService = Service.of({
      snapshot,
      controllers: Effect.map(SubscriptionRef.get(controllers), (items) =>
        Array.from(items),
      ),
      controllerChanges: SubscriptionRef.changes(controllers).pipe(
        Stream.map((items) => Array.from(items)),
      ),
      affinityChanges: SubscriptionRef.changes(affinityUpdates),
      serializers: Effect.map(Ref.get(serializers), (items) =>
        Array.from(items),
      ),
      statusBarProviders: Effect.map(
        Ref.get(statusBarProviders),
        (providers) => [...providers],
      ),
      openNotebook,
      closeNotebook,
      notebookChange,
      setActiveNotebookEditor,
      setActiveTextEditor,
      selectQuickPick: (label) =>
        Queue.offer(quickPickResponses, QuickPickResponse.Single({ label })),
      selectQuickPickMany: (labels) =>
        Queue.offer(
          quickPickResponses,
          QuickPickResponse.Many({ labels: [...labels] }),
        ),
      selectInformationMessage: (item) =>
        Queue.offer(informationMessageResponses, item),
      configurationChange: (event) =>
        PubSub.publish(configurationChanges, event).pipe(Effect.asVoid),
      awaitExecutions: (predicate) =>
        SubscriptionRef.changes(executionRevision).pipe(
          Stream.mapEffect(() => Ref.get(executions)),
          Stream.filter(predicate),
          Stream.runHead,
          Effect.asVoid,
        ),
      awaitInformationMessages: (count) =>
        SubscriptionRef.changes(informationMessageRevision).pipe(
          Stream.mapEffect(() => Ref.get(informationMessages)),
          Stream.filter((messages) => messages.length >= count),
          Stream.runHead,
          Effect.asVoid,
        ),
      selectNotebookController,
      rendererMessaging,
    });

    const testLayer = Layer.merge(layer, Layer.succeed(Service, testService));

    return new TestVsCode({
      layer: testLayer,
      views,
      commands,
      executions,
      controllers,
      serializers,
      statusBarProviders,
      documentChangesPubSub: documentChanges,
      documentOpenedPubSub: documentOpened,
      documentClosedPubSub: documentClosed,
      documentLifecyclePubSub: documentLifecycle,
      affinityUpdates,
      setActiveNotebookEditor,
      selectNotebookController,
      rendererMessaging,
      setActiveTextEditor,
      addNotebookDocument,
      removeNotebookDocument,
    });
  });

  static layer = TestVsCode.make().pipe(
    Effect.map((test) => test.layer),
    Layer.unwrap,
  );
}

export const makeNotebookEditor = (
  uri: string | Uri,
  options: NotebookEditorOptions = {},
) => TestVsCode.makeNotebookEditor(uri, options);

/** @deprecated Prefer `layer` or `layerWith` and yield `Service` in tests. */
export const make = TestVsCode.make;

export const layerWith = (options: Options) =>
  Layer.unwrap(make(options).pipe(Effect.map((test) => test.layer)));

export const layer = layerWith({});
