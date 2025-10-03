import { Effect, HashMap, Option, Ref } from "effect";
import type * as vscode from "vscode";
import { getNotebookUri, type NotebookUri } from "../types.ts";
import { VsCode } from "./VsCode.ts";

export class EditoryRegistry extends Effect.Service<EditoryRegistry>()(
  "EditoryRegistry",
  {
    dependencies: [VsCode.Default],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const ref = yield* Ref.make(
        HashMap.empty<NotebookUri, vscode.NotebookEditor>(),
      );
      yield* code.window.onDidChangeActiveNotebookEditor(
        Effect.fnUntraced(function* (editor) {
          if (Option.isNone(editor)) {
            return;
          }
          yield* Ref.update(ref, (map) =>
            HashMap.set(
              map,
              getNotebookUri(editor.value.notebook),
              editor.value,
            ),
          );
        }),
      );
      return {
        getLastNotebookEditor(id: NotebookUri) {
          return Effect.map(Ref.get(ref), HashMap.get(id));
        },
      };
    }),
  },
) {}
