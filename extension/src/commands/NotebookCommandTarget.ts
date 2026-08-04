import { Effect, Option, Schema } from "effect";
import type * as vscode from "vscode";

import {
  type MarimoCommand,
  VscodeUriSchema,
  withOptionalFirstArgument,
} from "../commands.ts";
import { VsCode } from "../platform/VsCode.ts";

const isVscodeUri = Schema.is(VscodeUriSchema);

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
    isVscodeUri(value.notebook.uri) &&
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
  // VS Code serializes its internal editor delegate across the extension-host
  // boundary. During editor lifecycle transitions its optional notebook URI
  // may be omitted, leaving an empty object here.
  notebookEditor: Schema.Struct({
    notebookUri: Schema.optional(VscodeUriSchema),
  }),
});

const NotebookToolbarContextShape = Schema.Union(
  NotebookToolbarTargetShape,
  NotebookToolbarInvocationShape,
);

export type NotebookToolbarContext = typeof NotebookToolbarContextShape.Type;

const NotebookToolbarContextSchema = Schema.declare<NotebookToolbarContext>(
  Schema.is(NotebookToolbarContextShape),
  { identifier: "vscode.NotebookToolbarContext" },
);

const NotebookCommandTargetSchema = Schema.Union(
  NotebookToolbarContextSchema,
  VscodeNotebookCellSchema,
);

export type NotebookCommandTarget = typeof NotebookCommandTargetSchema.Type;

export function withOptionalNotebookTarget(
  command: MarimoCommand,
): MarimoCommand<[target?: NotebookCommandTarget], void> {
  return withOptionalFirstArgument(command, NotebookCommandTargetSchema);
}

export function withOptionalNotebookToolbarContext(
  command: MarimoCommand,
): MarimoCommand<[context?: NotebookToolbarContext], void> {
  return withOptionalFirstArgument(command, NotebookToolbarContextSchema);
}

/**
 * Resolve the notebook that originated a toolbar command. A complete target
 * must resolve exactly; a toolbar invocation hint without a serialized URI
 * falls back to the active notebook.
 */
export const getNotebookCommandEditor = Effect.fn(
  "command.getNotebookCommandEditor",
)(function* (context?: NotebookCommandTarget) {
  const code = yield* VsCode;

  if (context !== undefined) {
    if ("notebook" in context) {
      const target = context.notebook.uri.toString();
      const editor = (yield* code.window.getVisibleNotebookEditors()).find(
        (candidate) => candidate.notebook.uri.toString() === target,
      );
      return Option.fromNullable(editor);
    }

    if (context.notebookEditor.notebookUri !== undefined) {
      const target = context.notebookEditor.notebookUri.toString();
      const editor = (yield* code.window.getVisibleNotebookEditors()).find(
        (candidate) => candidate.notebook.uri.toString() === target,
      );
      return Option.fromNullable(editor);
    }
  }

  return yield* code.window.getActiveNotebookEditor();
});
