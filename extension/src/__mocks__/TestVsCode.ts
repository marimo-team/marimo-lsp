import * as NodeEvents from "node:events";
import * as NodePath from "node:path";
import { Effect, Either, Layer, Option, Stream } from "effect";
import type * as vscode from "vscode";
import {
  Auth,
  Commands,
  Debug,
  Env,
  Notebooks,
  ParseUriError,
  VsCode,
  Window,
  Workspace,
} from "../services/VsCode.ts";

export const TestVsCodeLive = Layer.scoped(
  VsCode,
  Effect.gen(function* () {
    return VsCode.make({
      // namespaces
      window: Window.make({
        showInputBox() {
          return Effect.succeed(Option.none());
        },
        showInformationMessage() {
          return Effect.succeed(Option.none());
        },
        showWarningMessage() {
          return Effect.succeed(Option.none());
        },
        showErrorMessage() {
          return Effect.succeed(Option.none());
        },
        showQuickPick() {
          return Effect.succeed(Option.none());
        },
        showQuickPickItems() {
          return Effect.succeed(Option.none());
        },
        createOutputChannel(name) {
          return Effect.acquireRelease(
            Effect.sync(() => {
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
            }),
            (disposable) => Effect.sync(() => disposable.dispose()),
          );
        },
        getActiveNotebookEditor() {
          return Option.none();
        },
        getVisibleNotebookEditors() {
          return [];
        },
        createTreeView<T>() {
          return Effect.acquireRelease(
            Effect.sync(() => {
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
            (disposable) => Effect.sync(() => disposable.dispose()),
          );
        },
        createStatusBarItem(
          id: string,
          alignment: vscode.StatusBarAlignment,
          priority?: number,
        ) {
          return Effect.acquireRelease(
            Effect.sync(() => ({
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
            })),
            (disposable) => Effect.sync(() => disposable.dispose()),
          );
        },
        activeNotebookEditorChanges(): Stream.Stream<
          Option.Option<vscode.NotebookEditor>
        > {
          return Stream.never;
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
        withProgress() {
          return Effect.void;
        },
      }),
      commands: Commands.make({
        executeCommand() {
          return Effect.void;
        },
        registerCommand() {
          return Effect.acquireRelease(
            Effect.succeed({ dispose() {} }),
            () => Effect.void,
          );
        },
      }),
      workspace: Workspace.make({
        getNotebookDocuments() {
          return [];
        },
        getConfiguration() {
          return {
            get: () => undefined,
            has: () => false,
            inspect: () => undefined,
            async update() {},
          };
        },
        getWorkspaceFolders() {
          return [];
        },
        registerNotebookSerializer() {
          return Effect.acquireRelease(
            Effect.succeed({ dispose() {} }),
            (disposable) => Effect.sync(() => disposable.dispose()),
          );
        },
        notebookDocumentChanges() {
          return Stream.never;
        },
        applyEdit() {
          return Effect.succeed(true);
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
              Uri.file("/mocks/foo_mo.py"),
              content,
            ),
          );
        },
      }),
      env: Env.make({
        openExternal() {
          return Effect.succeed(true);
        },
      }),
      debug: Debug.make({
        registerDebugConfigurationProvider() {
          return Effect.acquireRelease(
            Effect.succeed({ dispose() {} }),
            (disposable) => Effect.sync(() => disposable.dispose()),
          );
        },
        registerDebugAdapterDescriptorFactory() {
          return Effect.acquireRelease(
            Effect.succeed({ dispose() {} }),
            (disposable) => Effect.sync(() => disposable.dispose()),
          );
        },
      }),
      notebooks: Notebooks.make({
        createNotebookController(id, notebookType, label) {
          return Effect.acquireRelease(
            Effect.sync(() => {
              const emitter = new EventEmitter();
              return {
                id,
                notebookType,
                label,
                onDidChangeSelectedNotebooks: emitter.event,
                dispose: () => {
                  emitter.dispose();
                },
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
                updateNotebookAffinity() {},
              };
            }),
            (disposable) => Effect.sync(() => disposable.dispose()),
          );
        },
        createRendererMessaging() {
          const emitter = new EventEmitter<{
            editor: vscode.NotebookEditor;
            message: unknown;
          }>();
          return Effect.succeed({
            postMessage: () => Promise.resolve(true),
            onDidReceiveMessage: emitter.event,
          });
        },
        registerNotebookCellStatusBarItemProvider() {
          return Effect.acquireRelease(
            Effect.succeed({ dispose() {} }),
            (disposable) => Effect.sync(() => disposable.dispose()),
          );
        },
      }),
      auth: Auth.make({
        getSession() {
          return Effect.succeed(Option.none());
        },
      }),
      NotebookData,
      NotebookCellData,
      NotebookCellKind: {
        Markup: 1,
        Code: 2,
      },
      NotebookCellOutput,
      NotebookCellOutputItem,
      NotebookEdit,
      NotebookCellStatusBarItem,
      NotebookCellStatusBarAlignment: {
        Left: 1,
        Right: 2,
      },
      WorkspaceEdit,
      EventEmitter,
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
      MarkdownString,
      // helper
      utils: {
        parseUri(value: string) {
          return Either.try({
            try: () => Uri.parse(value, /* strict */ true),
            catch: (cause) => new ParseUriError({ cause }),
          });
        },
      },
    });
  }),
);

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

class NotebookRange implements vscode.NotebookRange {
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

class Uri implements vscode.Uri {
  static parse(value: string, strict?: boolean): Uri {
    if (strict !== true) {
      throw new Error("strict parameter must be true in test mock");
    }
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
    if (skipEncoding !== undefined) {
      throw new Error("skipEncoding parameter not supported in test mock");
    }
    const url = new URL("blank:");
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
    if (typeof startOrLine === "number") {
      this.start = new Position(startOrLine, endOrCharacter as number);
      this.end = new Position(endLine as number, endCharacter as number);
    } else {
      this.start = startOrLine;
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
    return edits.filter((e) => e instanceof TextEdit) as TextEdit[];
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
      const textEdits = edits.filter(
        (e) => e instanceof TextEdit,
      ) as TextEdit[];
      result.push([Uri.parse(uriString, true), textEdits]);
    }
    return result;
  }
}

class EventEmitter<T> implements vscode.EventEmitter<T> {
  #emitter: NodeEvents.EventEmitter = new NodeEvents.EventEmitter();
  #disposed: boolean = false;

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
    if (disposables) {
      disposables.push(disposable);
    }
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

class NotebookCell implements vscode.NotebookCell {
  readonly index: number;
  readonly notebook: vscode.NotebookDocument;
  readonly kind: vscode.NotebookCellKind;
  readonly metadata: { readonly [key: string]: unknown };
  readonly outputs: readonly NotebookCellOutput[];
  readonly executionSummary: vscode.NotebookCellExecutionSummary | undefined;

  // TODO
  get document(): vscode.TextDocument {
    throw Error(
      "NotebookCell.TextDocument not implemented in TestVsCode service.",
    );
  }

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
  }
}

class NotebookDocument implements vscode.NotebookDocument {
  readonly uri: Uri;
  readonly notebookType: string;
  readonly version: number;
  readonly isDirty: boolean;
  readonly isUntitled: boolean;
  readonly isClosed: boolean;
  readonly metadata: Record<string, unknown>;
  readonly cellCount: number;

  private _cells: vscode.NotebookCell[];

  constructor(notebookType: string, uri: Uri, content?: vscode.NotebookData) {
    this.uri = uri;
    this.notebookType = notebookType;
    this.version = 1;
    this.isDirty = false;
    this.isUntitled = false;
    this.isClosed = false;
    this.metadata = {};

    const cellData = content?.cells ?? [];
    this.cellCount = cellData.length;
    this._cells = cellData.map(
      (data, index) => new NotebookCell(this, data, index),
    );
  }

  cellAt(index: number): vscode.NotebookCell {
    if (index < 0 || index >= this._cells.length) {
      throw new Error(`Cell index ${index} out of bounds`);
    }
    return this._cells[index];
  }

  getCells(range?: vscode.NotebookRange): vscode.NotebookCell[] {
    if (!range) {
      return this._cells;
    }
    return this._cells.slice(range.start, range.end);
  }

  save() {
    return Promise.resolve(true);
  }
}
