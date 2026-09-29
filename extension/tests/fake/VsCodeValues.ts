import * as NodeEvents from "node:events";
import * as NodePath from "node:path";

import type * as vscode from "vscode";

import { NOTEBOOK_TYPE } from "../../src/constants.ts";

export class NotebookCellData implements vscode.NotebookCellData {
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

export class NotebookData implements vscode.NotebookData {
  cells: vscode.NotebookCellData[];
  metadata?: { [key: string]: unknown };
  constructor(cells: NotebookCellData[]) {
    this.cells = cells;
  }
}

export class NotebookCellOutput implements NotebookCellOutput {
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

export class NotebookCellOutputItem implements NotebookCellOutputItem {
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

export class LanguageModelTextPart implements vscode.LanguageModelTextPart {
  value: string;
  constructor(value: string) {
    this.value = value;
  }
}

export class LanguageModelToolResult implements vscode.LanguageModelToolResult {
  content: unknown[];
  constructor(content: unknown[]) {
    this.content = content;
  }
}

export class NotebookEdit implements vscode.NotebookEdit {
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

export class NotebookCellStatusBarItem
  implements vscode.NotebookCellStatusBarItem
{
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

export class Position implements vscode.Position {
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

export class Range implements vscode.Range {
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

export class RelativePattern implements vscode.RelativePattern {
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

export class CodeLens implements vscode.CodeLens {
  readonly range: Range;
  command?: vscode.Command;
  readonly isResolved: boolean;

  constructor(range: Range, command?: vscode.Command) {
    this.range = range;
    this.command = command;
    this.isResolved = command !== undefined;
  }
}

export class SemanticTokensLegend implements vscode.SemanticTokensLegend {
  readonly tokenTypes: string[];
  readonly tokenModifiers: string[];

  constructor(tokenTypes: string[], tokenModifiers: string[] = []) {
    this.tokenTypes = tokenTypes;
    this.tokenModifiers = tokenModifiers;
  }
}

export class SemanticTokens implements vscode.SemanticTokens {
  readonly resultId: string | undefined;
  readonly data: Uint32Array;

  constructor(data: Uint32Array, resultId?: string) {
    this.data = data;
    this.resultId = resultId;
  }
}

export class Selection extends Range implements vscode.Selection {
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

export class TextEdit implements vscode.TextEdit {
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

export class WorkspaceEdit implements vscode.WorkspaceEdit {
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

export class EventEmitter<T> implements vscode.EventEmitter<T> {
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

export class ThemeColor implements vscode.ThemeColor {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

export class ThemeIcon implements vscode.ThemeIcon {
  static readonly File = new ThemeIcon("file");
  static readonly Folder = new ThemeIcon("folder");
  readonly id: string;
  readonly color?: ThemeColor | undefined;
  constructor(id: string, color?: ThemeColor) {
    this.id = id;
    this.color = color;
  }
}

export class MarkdownString implements vscode.MarkdownString {
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

export class TreeItem implements vscode.TreeItem {
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

export class TextDocument implements vscode.TextDocument {
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

export class TextEditor implements vscode.TextEditor {
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

export class NotebookCell implements vscode.NotebookCell {
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

export class NotebookDocument implements vscode.NotebookDocument {
  readonly uri: Uri;
  readonly notebookType: string;
  readonly isDirty: boolean;
  readonly isUntitled: boolean;
  readonly metadata: Record<string, unknown>;

  #cells: vscode.NotebookCell[];
  #isClosed = false;
  #version = 1;

  get version(): number {
    return this.#version;
  }

  get cellCount(): number {
    return this.#cells.length;
  }

  get isClosed(): boolean {
    return this.#isClosed;
  }

  constructor(notebookType: string, uri: Uri, content?: vscode.NotebookData) {
    this.uri = uri;
    this.notebookType = notebookType;
    this.isDirty = false;
    this.isUntitled = false;
    this.metadata = content?.metadata ?? {};

    const cellData = content?.cells ?? [];
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

  replaceCells(cells: ReadonlyArray<vscode.NotebookCellData>) {
    this.#cells = cells.map(
      (data, index) => new NotebookCell(this, data, index),
    );
    this.#version += 1;
  }
}

export function closeNotebookDocument(document: vscode.NotebookDocument) {
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

export function replaceTestNotebookCells(
  notebook: vscode.NotebookDocument,
  cells: ReadonlyArray<vscode.NotebookCellData>,
): void {
  if (!(notebook instanceof NotebookDocument)) {
    throw new Error("Expected a VsCodeTest NotebookDocument");
  }
  notebook.replaceCells(cells);
}

export class NotebookEditor implements vscode.NotebookEditor {
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

export class CompletionItem implements vscode.CompletionItem {
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

export class CompletionList<
  T extends CompletionItem = CompletionItem,
> implements vscode.CompletionList<T> {
  isIncomplete: boolean;
  items: T[];
  constructor(items: T[], isIncomplete = false) {
    this.items = items;
    this.isIncomplete = isIncomplete;
  }
}

export class Location implements vscode.Location {
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
export class Hover implements vscode.Hover {
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

export class DocumentHighlight implements vscode.DocumentHighlight {
  range: Range;
  kind?: vscode.DocumentHighlightKind;
  constructor(range: Range, kind?: vscode.DocumentHighlightKind) {
    this.range = range;
    this.kind = kind;
  }
}

export class DocumentSymbol implements vscode.DocumentSymbol {
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

export class FoldingRange implements vscode.FoldingRange {
  start: number;
  end: number;
  kind?: vscode.FoldingRangeKind;
  constructor(start: number, end: number, kind?: vscode.FoldingRangeKind) {
    this.start = start;
    this.end = end;
    this.kind = kind;
  }
}

export class SelectionRange implements vscode.SelectionRange {
  range: Range;
  parent?: SelectionRange;
  constructor(range: Range, parent?: SelectionRange) {
    this.range = range;
    this.parent = parent;
  }
}

export class CodeActionKind {
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

export class CodeAction {
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

export class SnippetString implements vscode.SnippetString {
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

export class InlayHintLabelPart implements vscode.InlayHintLabelPart {
  value: string;
  tooltip?: string | MarkdownString;
  location?: Location;
  command?: vscode.Command;
  constructor(value: string) {
    this.value = value;
  }
}

export class InlayHint implements vscode.InlayHint {
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

export class SignatureHelp implements vscode.SignatureHelp {
  signatures: SignatureInformation[] = [];
  activeSignature = 0;
  activeParameter = 0;
}

export class SignatureInformation implements vscode.SignatureInformation {
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

export class ParameterInformation implements vscode.ParameterInformation {
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

export class Diagnostic implements vscode.Diagnostic {
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

export class DiagnosticCollection implements vscode.DiagnosticCollection {
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

export const makeNotebookEditor = (
  uri: string | Uri,
  options: NotebookEditorOptions = {},
) => createTestNotebookEditor(createTestNotebookDocument(uri, options));
