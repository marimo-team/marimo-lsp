import {
  Context,
  Effect,
  HashMap,
  Layer,
  Option,
  Ref,
  Stream,
  SubscriptionRef,
} from "effect";
import type * as vscode from "vscode";

import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";
import type { NotebookId } from "../schemas/MarimoNotebookDocument.ts";
import { Telemetry } from "../telemetry/Telemetry.ts";

export interface Interface {
  readonly getNotebookEditors: Effect.Effect<
    Array<[NotebookId, vscode.NotebookEditor]>
  >;
  readonly getLastNotebookEditor: (
    id: NotebookId,
  ) => Effect.Effect<Option.Option<vscode.NotebookEditor>>;
  readonly getActiveNotebookUri: Effect.Effect<Option.Option<NotebookId>>;
  readonly getNotebookEditor: (
    id: NotebookId,
  ) => Effect.Effect<Option.Option<vscode.NotebookEditor>>;
  readonly getActiveNotebookEditor: Effect.Effect<
    Option.Option<vscode.NotebookEditor>
  >;
  readonly streamActiveNotebookChanges: Stream.Stream<
    Option.Option<NotebookId>
  >;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/NotebookEditorRegistry",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const code = yield* VsCode;
    const telemetry = yield* Telemetry;
    const ref = yield* Ref.make(
      HashMap.empty<NotebookId, vscode.NotebookEditor>(),
    );

    // Track the currently active notebook URI
    const activeNotebookRef = yield* SubscriptionRef.make(
      Option.none<NotebookId>(),
    );

    yield* Effect.forkScoped(
      code.window.activeNotebookEditorChanges.pipe(
        Stream.runForEach(
          Effect.fn(function* (editor) {
            const notebook = Option.flatMap(editor, (editor) =>
              MarimoNotebookDocument.tryFrom(editor.notebook),
            );
            if (Option.isNone(editor) || Option.isNone(notebook)) {
              yield* SubscriptionRef.set(activeNotebookRef, Option.none());
              return;
            }

            // Only track marimo notebooks
            if (Option.isNone(notebook)) {
              yield* SubscriptionRef.set(activeNotebookRef, Option.none());
              return;
            }

            const isNewNotebook = HashMap.has(
              yield* Ref.get(ref),
              notebook.value.id,
            );

            yield* Ref.update(ref, (map) =>
              HashMap.set(map, notebook.value.id, editor.value),
            );

            yield* Effect.logInfo("Active notebook changed").pipe(
              Effect.annotateLogs({ notebookUri: notebook.value.id }),
            );

            // Track notebook opened event (only for new notebooks)
            if (!isNewNotebook) {
              yield* telemetry.notebookOpened(editor.value.notebook.cellCount);
            }

            yield* SubscriptionRef.set(
              activeNotebookRef,
              Option.some(notebook.value.id),
            );
          }),
        ),
      ),
    );

    const getLastNotebookEditor = Effect.fn(
      "NotebookEditorRegistry.getLastNotebookEditor",
    )(function* (id: NotebookId) {
      const editors = yield* Ref.get(ref);
      return HashMap.get(editors, id);
    });

    const getNotebookEditor = Effect.fn(
      "NotebookEditorRegistry.getNotebookEditor",
    )(function* (id: NotebookId) {
      const editors = yield* Ref.get(ref);
      return HashMap.get(editors, id);
    });

    return Service.of({
      getNotebookEditors: Effect.map(Ref.get(ref), HashMap.toEntries),
      getLastNotebookEditor,

      /**
       * Get the currently active notebook URI
       */
      getActiveNotebookUri: SubscriptionRef.get(activeNotebookRef),

      getNotebookEditor,

      /**
       * Get the currently active notebook editor
       */
      getActiveNotebookEditor: Effect.gen(function* () {
        const activeNotebookUri = yield* SubscriptionRef.get(activeNotebookRef);

        if (Option.isNone(activeNotebookUri)) {
          yield* Effect.logWarning("No active notebook editor");
          return Option.none();
        }

        const editors = yield* Ref.get(ref);
        return HashMap.get(editors, activeNotebookUri.value);
      }),

      /**
       * Stream of active notebook URI changes.
       *
       * Emits the current value on subscription, then all subsequent changes.
       * Filters consecutive duplicates via Stream.changes.
       */
      streamActiveNotebookChanges: SubscriptionRef.changes(
        activeNotebookRef,
      ).pipe(Stream.changes),
    });
  }),
);
