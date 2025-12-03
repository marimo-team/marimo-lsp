import { Effect, HashMap, Option, Ref, Stream, SubscriptionRef } from "effect";
import type * as vscode from "vscode";
import { MarimoNotebookDocument } from "../schemas.ts";
import { getNotebookUri, type NotebookUri } from "../types.ts";
import { Log } from "../utils/log.ts";
import { Telemetry } from "./Telemetry.ts";
import { VsCode } from "./VsCode.ts";

export class NotebookEditorRegistry extends Effect.Service<NotebookEditorRegistry>()(
  "NotebookEditorRegistry",
  {
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const telemetry = yield* Telemetry;
      const ref = yield* Ref.make(
        HashMap.empty<NotebookUri, vscode.NotebookEditor>(),
      );

      // Track the currently active notebook URI
      const activeNotebookRef = yield* SubscriptionRef.make(
        Option.none<NotebookUri>(),
      );

      yield* Effect.forkScoped(
        code.window.activeNotebookEditorChanges().pipe(
          Stream.mapEffect(
            Effect.fnUntraced(function* (editor) {
              const notebook = Option.filterMap(editor, (editor) =>
                MarimoNotebookDocument.decodeUnknownNotebookDocument(
                  editor.notebook,
                ),
              );
              if (Option.isNone(editor) || Option.isNone(notebook)) {
                yield* SubscriptionRef.set(activeNotebookRef, Option.none());
                return;
              }
              const notebookUri = getNotebookUri(editor.value.notebook);

              // Only track marimo notebooks
              if (Option.isNone(notebook)) {
                yield* SubscriptionRef.set(activeNotebookRef, Option.none());
                return;
              }

              const isNewNotebook = HashMap.has(
                yield* Ref.get(ref),
                notebookUri,
              );

              yield* Ref.update(ref, (map) =>
                HashMap.set(map, notebookUri, editor.value),
              );

              yield* Log.info("Active notebook changed", {
                notebookUri,
              });

              // Track notebook opened event (only for new notebooks)
              if (!isNewNotebook) {
                yield* telemetry.capture("notebook_opened", {
                  cellCount: editor.value.notebook.cellCount,
                });
              }

              yield* SubscriptionRef.set(
                activeNotebookRef,
                Option.some(notebookUri),
              );
            }),
          ),
          Stream.runDrain,
        ),
      );

      return {
        getNotebookEditors() {
          return Effect.map(Ref.get(ref), HashMap.toEntries);
        },
        /**
         * Get the last notebook editor for a given notebook URI
         */
        getLastNotebookEditor(id: NotebookUri) {
          return Effect.map(Ref.get(ref), HashMap.get(id));
        },

        /**
         * Get the currently active notebook URI
         */
        getActiveNotebookUri() {
          return SubscriptionRef.get(activeNotebookRef);
        },

        /**
         * Get the notebook editor for a given notebook URI
         */
        getNotebookEditor(uri: NotebookUri) {
          return Effect.map(Ref.get(ref), HashMap.get(uri));
        },

        /**
         * Get the currently active notebook editor
         */
        getActiveNotebookEditor() {
          return Effect.gen(function* () {
            const activeNotebookUri =
              yield* SubscriptionRef.get(activeNotebookRef);

            if (Option.isNone(activeNotebookUri)) {
              yield* Log.warn("No active notebook editor");
              return Option.none();
            }

            const editors = yield* Ref.get(ref);
            return HashMap.get(editors, activeNotebookUri.value);
          });
        },

        /**
         * Stream of active notebook URI changes.
         *
         * Emits the current value on subscription, then all subsequent changes.
         * Filters consecutive duplicates via Stream.changes.
         */
        streamActiveNotebookChanges() {
          return activeNotebookRef.changes.pipe(Stream.changes);
        },
      };
    }),
  },
) {}
