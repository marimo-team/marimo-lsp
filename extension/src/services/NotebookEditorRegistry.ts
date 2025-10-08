import { Effect, HashMap, Option, Ref, Stream, SubscriptionRef } from "effect";
import type * as vscode from "vscode";
import { getNotebookUri, type NotebookUri } from "../types.ts";
import { Log } from "../utils/log.ts";
import { isMarimoNotebookDocument } from "../utils/notebook.ts";
import { VsCode } from "./VsCode.ts";

export class NotebookEditorRegistry extends Effect.Service<NotebookEditorRegistry>()(
  "NotebookEditorRegistry",
  {
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
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
              if (Option.isNone(editor)) {
                yield* SubscriptionRef.set(activeNotebookRef, Option.none());
                return;
              }

              const notebookUri = getNotebookUri(editor.value.notebook);

              // Only track marimo notebooks
              if (!isMarimoNotebookDocument(editor.value.notebook)) {
                yield* SubscriptionRef.set(activeNotebookRef, Option.none());
                return;
              }

              yield* Ref.update(ref, (map) =>
                HashMap.set(map, notebookUri, editor.value),
              );

              yield* Log.info("Active notebook changed", {
                notebookUri,
              });
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
         * Stream of active notebook URI changes
         */
        streamActiveNotebookChanges() {
          return activeNotebookRef.changes.pipe(Stream.changes);
        },
      };
    }),
  },
) {}
