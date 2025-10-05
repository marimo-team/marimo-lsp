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
              yield* Log.info("Active notebook changed", { notebookUri });

              // Only track marimo notebooks
              if (!isMarimoNotebookDocument(editor.value.notebook)) {
                yield* SubscriptionRef.set(activeNotebookRef, Option.none());
                return;
              }

              yield* Ref.update(ref, (map) =>
                HashMap.set(map, notebookUri, editor.value),
              );

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
         * Stream of active notebook URI changes
         */
        streamActiveNotebookChanges() {
          return Stream.changes(activeNotebookRef);
        },
      };
    }),
  },
) {}
