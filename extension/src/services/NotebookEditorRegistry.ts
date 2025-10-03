import { Effect, HashMap, Option, Ref, Stream, SubscriptionRef } from "effect";
import type * as vscode from "vscode";
import { getNotebookUri, type NotebookUri } from "../types.ts";
import { isMarimoNotebookDocument } from "../utils/notebook.ts";
import { VsCode } from "./VsCode.ts";

export class NotebookEditorRegistry extends Effect.Service<NotebookEditorRegistry>()(
  "NotebookEditorRegistry",
  {
    dependencies: [VsCode.Default],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const ref = yield* Ref.make(
        HashMap.empty<NotebookUri, vscode.NotebookEditor>(),
      );

      // Track the currently active notebook URI
      const activeNotebookRef = yield* SubscriptionRef.make(
        Option.none<NotebookUri>(),
      );

      yield* code.window.onDidChangeActiveNotebookEditor(
        Effect.fnUntraced(function* (editor) {
          // TODO: should we filter out non-marimo notebooks?
          // if (!isMarimoNotebookDocument(e.notebook)) {
          //   return;
          // }

          if (Option.isNone(editor)) {
            yield* SubscriptionRef.set(activeNotebookRef, Option.none());
            return;
          }

          const notebookUri = getNotebookUri(editor.value.notebook);

          yield* Ref.update(ref, (map) =>
            HashMap.set(map, notebookUri, editor.value),
          );

          yield* SubscriptionRef.set(
            activeNotebookRef,
            Option.some(notebookUri),
          );
        }),
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
         * Get all marimo notebook documents
         */
        getMarimoNotebookDocuments() {
          return code.workspace
            .getNotebookDocuments()
            .filter((notebook) => isMarimoNotebookDocument(notebook));
        },

        /**
         * Stream of active notebook URI changes
         */
        get activeNotebookChanges() {
          return Stream.changes(activeNotebookRef);
        },
      };
    }),
  },
) {}
