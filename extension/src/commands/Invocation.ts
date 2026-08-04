import { Effect, Option, ParseResult, Schema } from "effect";
import type * as vscode from "vscode";

import {
  type CommandArguments,
  type CommandInvocation,
  VscodeUriSchema,
} from "../commands.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../schemas/MarimoNotebookDocument.ts";

type Concat<Left extends CommandArguments, Right extends CommandArguments> = [
  ...Left,
  ...Right,
];

export interface InvocationAdapter<
  CallArgs extends CommandArguments,
  HandlerArgs extends CommandArguments,
  Requirements = never,
> extends CommandInvocation<CallArgs, HandlerArgs, Requirements> {
  readonly surface: string;
  readonly contributed: boolean;
  readonly consumedArguments: number;
  readonly decode: (
    args: ReadonlyArray<unknown>,
  ) => Effect.Effect<HandlerArgs, ParseResult.ParseError, Requirements>;
}

type AnyInvocationAdapter = InvocationAdapter<
  CommandArguments,
  CommandArguments,
  unknown
>;

type CallArgsOf<Adapter> =
  Adapter extends InvocationAdapter<infer Args, CommandArguments, unknown>
    ? Args
    : never;

type RequirementsOf<Adapter> =
  Adapter extends InvocationAdapter<CommandArguments, CommandArguments, infer R>
    ? R
    : never;

const makeAdapter = <
  CallArgs extends CommandArguments,
  HandlerArgs extends CommandArguments,
  Requirements,
>(
  surface: string,
  contributed: boolean,
  consumedArguments: number,
  decode: InvocationAdapter<CallArgs, HandlerArgs, Requirements>["decode"],
): InvocationAdapter<CallArgs, HandlerArgs, Requirements> => ({
  surface,
  surfaces: [surface],
  contributedSurfaces: contributed ? [surface] : [],
  contributed,
  consumedArguments,
  decode,
});

const noTarget = (surface: string, contributed: boolean) =>
  makeAdapter<[], [], never>(surface, contributed, 0, () => Effect.succeed([]));

const decodeOptional = <A, I>(schema: Schema.Schema<A, I>) =>
  Schema.decodeUnknown(Schema.UndefinedOr(schema));

const optionalArgument = <A>(value: A | undefined): [argument?: A] =>
  value === undefined ? [] : [value];

export const VscodeNotebookCellSchema = Schema.declare<vscode.NotebookCell>(
  (value): value is vscode.NotebookCell =>
    typeof value === "object" &&
    value !== null &&
    "index" in value &&
    typeof value.index === "number" &&
    "notebook" in value &&
    typeof value.notebook === "object" &&
    value.notebook !== null &&
    "uri" in value.notebook &&
    Schema.is(VscodeUriSchema)(value.notebook.uri) &&
    "document" in value &&
    typeof value.document === "object" &&
    value.document !== null,
  { identifier: "vscode.NotebookCell" },
);

const NotebookToolbarTargetShape = Schema.Struct({
  notebookEditor: Schema.Struct({ notebookUri: VscodeUriSchema }),
});

const NotebookToolbarInvocationShape = Schema.Struct({
  ui: Schema.Literal(true),
  source: Schema.Literal("notebookToolbar"),
  notebookEditor: Schema.Struct({
    notebookUri: Schema.optional(VscodeUriSchema),
  }),
});

const NotebookToolbarContextShape = Schema.Union(
  NotebookToolbarTargetShape,
  NotebookToolbarInvocationShape,
);

export type NotebookToolbarContext = typeof NotebookToolbarContextShape.Type;

export type NotebookTarget = {
  readonly document: MarimoNotebookDocument;
  readonly editor: vscode.NotebookEditor;
};

const NotebookToolbarContextSchema = Schema.declare<NotebookToolbarContext>(
  Schema.is(NotebookToolbarContextShape),
  { identifier: "vscode.NotebookToolbarContext" },
);

const notebookFromEditor = (
  editor: vscode.NotebookEditor,
): Option.Option<NotebookTarget> =>
  Option.map(MarimoNotebookDocument.tryFrom(editor.notebook), (document) => ({
    document,
    editor,
  }));

const activeNotebook = Effect.gen(function* () {
  const code = yield* VsCode;
  return Option.flatMap(
    yield* code.window.getActiveNotebookEditor(),
    notebookFromEditor,
  );
});

const notebookForUri = Effect.fn(function* (uri: vscode.Uri) {
  const code = yield* VsCode;
  const target = uri.toString();
  const editor = (yield* code.window.getVisibleNotebookEditors()).find(
    (candidate) => candidate.notebook.uri.toString() === target,
  );
  return Option.flatMap(Option.fromNullable(editor), notebookFromEditor);
});

const notebookFromToolbarContext = Effect.fn(function* (
  context?: NotebookToolbarContext,
) {
  const uri = context?.notebookEditor.notebookUri;
  return uri === undefined ? yield* activeNotebook : yield* notebookForUri(uri);
});

const notebookFromCell = Effect.fn(function* (cell: vscode.NotebookCell) {
  return yield* notebookForUri(cell.notebook.uri);
});

const activeNotebookCell = Effect.gen(function* () {
  const code = yield* VsCode;
  const editor = yield* code.window.getActiveNotebookEditor();
  if (Option.isNone(editor)) return Option.none<MarimoNotebookCell>();
  const notebook = MarimoNotebookDocument.tryFrom(editor.value.notebook);
  if (Option.isNone(notebook)) return Option.none<MarimoNotebookCell>();
  return Option.fromNullable(
    notebook.value.getCells()[editor.value.selection.start],
  );
});

const commandPalette = {
  none: noTarget("commandPalette", true),
  notebook: makeAdapter<[], [notebook: Option.Option<NotebookTarget>], VsCode>(
    "commandPalette",
    true,
    0,
    (args) =>
      Schema.decodeUnknown(Schema.Tuple())(args).pipe(
        Effect.andThen(activeNotebook),
        Effect.map((notebook) => [notebook]),
      ),
  ),
  notebookCell: makeAdapter<
    [],
    [cell: Option.Option<MarimoNotebookCell>],
    VsCode
  >("commandPalette", true, 0, (args) =>
    Schema.decodeUnknown(Schema.Tuple())(args).pipe(
      Effect.andThen(activeNotebookCell),
      Effect.map((cell) => [cell]),
    ),
  ),
  resource: makeAdapter<[], [resource?: string | vscode.Uri], never>(
    "commandPalette",
    true,
    0,
    (args) => Schema.decodeUnknown(Schema.Tuple())(args).pipe(Effect.as([])),
  ),
} as const;

const notebookToolbar = {
  none: noTarget("notebookToolbar", true),
  notebook: makeAdapter<
    [context?: NotebookToolbarContext],
    [notebook: Option.Option<NotebookTarget>],
    VsCode
  >("notebookToolbar", true, 1, (args) =>
    decodeOptional(NotebookToolbarContextSchema)(args[0]).pipe(
      Effect.flatMap(notebookFromToolbarContext),
      Effect.map((notebook) => [notebook]),
    ),
  ),
} as const;

const notebookCellTitle = {
  notebook: makeAdapter<
    [cell: vscode.NotebookCell],
    [notebook: Option.Option<NotebookTarget>],
    VsCode
  >("notebookCellTitle", true, 1, (args) =>
    Schema.decodeUnknown(VscodeNotebookCellSchema)(args[0]).pipe(
      Effect.flatMap(notebookFromCell),
      Effect.map((notebook) => [notebook]),
    ),
  ),
  notebookCell: makeAdapter<
    [cell: vscode.NotebookCell],
    [cell: Option.Option<MarimoNotebookCell>],
    never
  >("notebookCellTitle", true, 1, (args) =>
    Schema.decodeUnknown(VscodeNotebookCellSchema)(args[0]).pipe(
      Effect.map((cell) => [Option.some(MarimoNotebookCell.from(cell))]),
    ),
  ),
} as const;

const notebookCellStatusBar = {
  notebook: makeAdapter<
    [cell: vscode.NotebookCell],
    [notebook: Option.Option<NotebookTarget>],
    VsCode
  >("notebookCellStatusBar", false, 1, (args) =>
    Schema.decodeUnknown(VscodeNotebookCellSchema)(args[0]).pipe(
      Effect.flatMap(notebookFromCell),
      Effect.map((notebook) => [notebook]),
    ),
  ),
  notebookCell: makeAdapter<
    [cell: vscode.NotebookCell],
    [cell: Option.Option<MarimoNotebookCell>],
    never
  >("notebookCellStatusBar", false, 1, (args) =>
    Schema.decodeUnknown(VscodeNotebookCellSchema)(args[0]).pipe(
      Effect.map((cell) => [Option.some(MarimoNotebookCell.from(cell))]),
    ),
  ),
} as const;

const optionalResource = (
  surface: string,
  contributed: boolean,
  consumedArguments: number,
) =>
  makeAdapter<
    [resource?: string | vscode.Uri],
    [resource?: string | vscode.Uri],
    never
  >(surface, contributed, consumedArguments, (args) =>
    decodeOptional(Schema.Union(Schema.String, VscodeUriSchema))(args[0]).pipe(
      Effect.map(optionalArgument),
    ),
  );

const programmaticNoTarget = (surface: string) => noTarget(surface, false);

const argument = <A, I>(
  surface: string,
  contributed: boolean,
  schema: Schema.Schema<A, I>,
) =>
  makeAdapter<[argument: A], [argument: A], never>(
    surface,
    contributed,
    1,
    (args) =>
      Schema.decodeUnknown(schema)(args[0]).pipe(
        Effect.map((value) => [value]),
      ),
  );

const join = <
  FirstCallArgs extends CommandArguments,
  HandlerArgs extends CommandArguments,
  FirstRequirements,
  // Requirements are recovered from `Rest` below; `any` prevents the
  // structural constraint from widening every adapter requirement to unknown.
  // oxlint-disable-next-line typescript/no-explicit-any
  const Rest extends ReadonlyArray<
    InvocationAdapter<CommandArguments, NoInfer<HandlerArgs>, any>
  >,
>(
  first: InvocationAdapter<FirstCallArgs, HandlerArgs, FirstRequirements>,
  ...rest: Rest
): CommandInvocation<
  FirstCallArgs | CallArgsOf<Rest[number]>,
  HandlerArgs,
  FirstRequirements | RequirementsOf<Rest[number]>
> => {
  const adapters: ReadonlyArray<AnyInvocationAdapter> = [first, ...rest];
  return {
    surfaces: [...new Set(adapters.map((adapter) => adapter.surface))],
    contributedSurfaces: [
      ...new Set(
        adapters
          .filter((adapter) => adapter.contributed)
          .map((adapter) => adapter.surface),
      ),
    ],
    decode: (args) =>
      Effect.firstSuccessOf([
        first.decode(args),
        ...rest.map((adapter) => adapter.decode(args)),
      ]),
  };
};

const withArguments = <
  CallArgs extends CommandArguments,
  HandlerArgs extends CommandArguments,
  Requirements,
  ExtraArgs extends CommandArguments,
  ExtraEncoded extends CommandArguments,
>(
  adapter: InvocationAdapter<CallArgs, HandlerArgs, Requirements>,
  schema: Schema.Schema<ExtraArgs, ExtraEncoded>,
  extraArgumentCount: number,
): InvocationAdapter<
  Concat<CallArgs, ExtraArgs>,
  Concat<HandlerArgs, ExtraArgs>,
  Requirements
> =>
  makeAdapter(
    adapter.surface,
    adapter.contributed,
    adapter.consumedArguments + extraArgumentCount,
    (args) =>
      Effect.all([
        adapter.decode(args),
        Schema.decodeUnknown(schema)(args.slice(adapter.consumedArguments)),
      ]).pipe(
        Effect.map(
          ([target, extra]): Concat<HandlerArgs, ExtraArgs> => [
            ...target,
            ...extra,
          ],
        ),
      ),
  );

export const Invocation = {
  join,
  withArguments,
  argument,
  CommandPalette: commandPalette,
  FileNew: {
    none: noTarget("fileNew", true),
  },
  NotebookToolbar: notebookToolbar,
  NotebookCellTitle: notebookCellTitle,
  EditorTitle: {
    none: noTarget("editorTitle", true),
    resource: optionalResource("editorTitle", true, 1),
  },
  ViewTitle: {
    none: noTarget("viewTitle", true),
  },
  ViewItemContext: {
    argument: <A, I>(schema: Schema.Schema<A, I>) =>
      argument("viewItemContext", true, schema),
  },
  StatusBar: {
    none: programmaticNoTarget("statusBar"),
  },
  NotebookCellStatusBar: notebookCellStatusBar,
  TreeItem: {
    argument: <A, I>(schema: Schema.Schema<A, I>) =>
      argument("treeItem", false, schema),
  },
  CodeLens: {
    resource: optionalResource("codeLens", false, 1),
  },
} as const;
