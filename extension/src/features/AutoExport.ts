import * as NodePath from "node:path";

import {
  type Context,
  Effect,
  Filter,
  HashMap,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect";
import type * as vscode from "vscode";

import { NotebookRuntime } from "../kernel/NotebookRuntime.ts";
import { MarimoClient } from "../lsp/MarimoClient.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  MarimoNotebookDocument,
  type NotebookId,
} from "../schemas/MarimoNotebookDocument.ts";

export const AUTO_EXPORT_INTERVAL = "5 seconds";

export type AutoExportFormat = "html" | "ipynb" | "markdown";
type AutoExportExtension = "html" | "ipynb" | "md";

interface AutoExportState {
  readonly incarnation: object;
  readonly generation: number;
  readonly exported: Readonly<Record<AutoExportFormat, number>>;
}

const initialState = (): AutoExportState => ({
  incarnation: {},
  generation: 0,
  exported: { html: -1, ipynb: -1, markdown: -1 },
});

export function autoExportUri(
  code: Context.Service.Shape<typeof VsCode>,
  notebook: MarimoNotebookDocument,
  extension: AutoExportExtension,
) {
  const basename = NodePath.posix.basename(notebook.uri.path);
  const notebookExtension = NodePath.posix.extname(basename);
  const stem =
    notebookExtension.length > 0
      ? basename.slice(0, -notebookExtension.length)
      : basename;
  return code.Uri.joinPath(
    notebook.uri,
    "..",
    "__marimo__",
    `${stem}.${extension}`,
  );
}

function marimoNotebooks(editors: ReadonlyArray<vscode.NotebookEditor>) {
  const notebooks = editors.flatMap((editor) =>
    Option.toArray(MarimoNotebookDocument.tryFrom(editor.notebook)),
  );
  return [
    ...new Map(notebooks.map((notebook) => [notebook.id, notebook])).values(),
  ];
}

export const AutoExportLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const marimo = yield* MarimoClient;
    const runtime = yield* NotebookRuntime;
    const states = yield* Ref.make(
      HashMap.empty<NotebookId, AutoExportState>(),
    );

    const getOrCreateState = (notebookId: NotebookId) =>
      Ref.modify(states, (current) =>
        Option.match(HashMap.get(current, notebookId), {
          onNone: () => {
            const state = initialState();
            return [state, HashMap.set(current, notebookId, state)];
          },
          onSome: (state) => [state, current],
        }),
      );

    const markDirty = (notebookId: NotebookId) =>
      Ref.update(states, (current) =>
        HashMap.modifyAt(current, notebookId, (state) => {
          const value = Option.getOrElse(state, initialState);
          return Option.some({ ...value, generation: value.generation + 1 });
        }),
      );

    const markExported = (
      notebookId: NotebookId,
      format: AutoExportFormat,
      exportedState: AutoExportState,
    ) =>
      Ref.update(states, (current) =>
        HashMap.modifyAt(current, notebookId, (state) =>
          Option.filter(state, (value) =>
            Object.is(value.incarnation, exportedState.incarnation),
          ).pipe(
            Option.map((value) => ({
              ...value,
              exported: {
                ...value.exported,
                [format]: exportedState.generation,
              },
            })),
          ),
        ),
      );

    const visibleNotebooks = Stream.concat(
      Stream.fromEffect(code.window.getVisibleNotebookEditors),
      code.window.visibleNotebookEditorsChanges,
    ).pipe(Stream.map(marimoNotebooks));

    yield* Effect.forkScoped(
      visibleNotebooks.pipe(
        Stream.runForEach((notebooks) =>
          Effect.forEach(notebooks, (notebook) => markDirty(notebook.id), {
            discard: true,
          }),
        ),
      ),
    );

    yield* Effect.forkScoped(
      marimo.operations.pipe(
        Stream.runForEach((message) => markDirty(message.notebookUri)),
      ),
    );

    yield* Effect.forkScoped(
      code.workspace.notebookDocumentChanges.pipe(
        Stream.filterMap(
          Filter.fromPredicateOption((event) =>
            MarimoNotebookDocument.tryFrom(event.notebook),
          ),
        ),
        Stream.runForEach((notebook) => markDirty(notebook.id)),
      ),
    );

    yield* Effect.forkScoped(
      code.workspace.notebookDocumentClosed.pipe(
        Stream.filterMap(
          Filter.fromPredicateOption((document) =>
            MarimoNotebookDocument.tryFrom(document),
          ),
        ),
        Stream.runForEach((notebook) =>
          Ref.update(states, HashMap.remove(notebook.id)),
        ),
      ),
    );

    yield* Effect.forkScoped(
      Stream.tick(AUTO_EXPORT_INTERVAL).pipe(
        Stream.runForEach(() =>
          Effect.gen(function* () {
            const editors = yield* code.window.getVisibleNotebookEditors;
            yield* Effect.forEach(marimoNotebooks(editors), exportNotebook, {
              concurrency: "unbounded",
              discard: true,
            });
          }),
        ),
      ),
    );

    function exportNotebook(notebook: MarimoNotebookDocument) {
      return Effect.gen(function* () {
        if (notebook.isUntitled) return;

        const metadata = yield* notebook.parseMetadata();
        const enabled = metadata.appConfig.auto_download;
        const formats = (["html", "ipynb", "markdown"] as const).filter(
          (format) => enabled.includes(format),
        );
        if (formats.length === 0) return;

        const session = yield* runtime.getRuntimeSession(notebook.id);
        if (Option.isNone(session)) return;

        const state = yield* getOrCreateState(notebook.id);
        const pendingFormats = formats.filter((format) => {
          if (state.exported[format] >= state.generation) return false;
          return (
            format !== "html" ||
            notebook.getCells().some((cell) => cell.outputs.length > 0)
          );
        });
        if (pendingFormats.length === 0) return;

        const outputDirectory = code.Uri.joinPath(
          notebook.uri,
          "..",
          "__marimo__",
        );
        yield* code.workspace.fs.createDirectory(outputDirectory);
        yield* Effect.forEach(
          pendingFormats,
          (format) => {
            return exportFormat(notebook, format).pipe(
              Effect.andThen(markExported(notebook.id, format, state)),
              Effect.catch((error) =>
                Effect.logWarning(
                  "Failed to automatically export notebook",
                ).pipe(
                  Effect.annotateLogs({
                    error,
                    format,
                    notebook: notebook.id,
                  }),
                ),
              ),
            );
          },
          { discard: true },
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Failed to process notebook for auto-export").pipe(
            Effect.annotateLogs({ error, notebook: notebook.id }),
          ),
        ),
      );
    }

    function exportFormat(
      notebook: MarimoNotebookDocument,
      format: AutoExportFormat,
    ) {
      const content = (() => {
        if (format === "html") {
          return marimo.exportAsHtml({
            notebookUri: notebook.id,
            inner: {
              download: false,
              files: [],
              includeCode: true,
              assetUrl: null,
            },
          });
        }
        if (format === "ipynb") {
          return marimo.exportAsIpynb({
            notebookUri: notebook.id,
            inner: {},
          });
        }
        return marimo.exportAsMarkdown({
          notebookUri: notebook.id,
          inner: {},
        });
      })();

      const extension = format === "markdown" ? "md" : format;
      const uri = autoExportUri(code, notebook, extension);
      return content.pipe(
        Effect.andThen(Schema.decodeUnknownEffect(Schema.String)),
        Effect.flatMap((value) =>
          code.workspace.fs.writeFile(uri, new TextEncoder().encode(value)),
        ),
        Effect.tap(() =>
          Effect.logInfo("Automatically exported notebook").pipe(
            Effect.annotateLogs({
              format,
              notebook: notebook.id,
              output: uri.toString(),
            }),
          ),
        ),
      );
    }
  }),
);
