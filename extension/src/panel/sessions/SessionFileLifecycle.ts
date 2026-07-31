import { Effect, Layer, Option, Schema, Stream } from "effect";

import { VsCode } from "../../platform/VsCode.ts";
import { NotebookIdFromString } from "../../schemas/MarimoNotebookDocument.ts";
import { SessionsService } from "./SessionsService.ts";

const decodeNotebookId = Schema.decodeUnknown(NotebookIdFromString);

/** Keeps live sessions aligned with notebook file rename and deletion events. */
export const SessionFileLifecycleLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const sessions = yield* SessionsService;
    const deletedWhileOpen = new Set<string>();

    yield* Effect.forkScoped(
      code.workspace.fileRenames().pipe(
        Stream.runForEach((event) =>
          Effect.forEach(
            event.files,
            ({ oldUri, newUri }) =>
              Effect.gen(function* () {
                const oldNotebookUri = yield* decodeNotebookId(
                  oldUri.toString(),
                );
                const session = yield* sessions.find(oldNotebookUri);
                if (Option.isNone(session)) return;
                const newNotebookUri = yield* decodeNotebookId(
                  newUri.toString(),
                );
                yield* sessions.move(oldNotebookUri, newNotebookUri);
              }).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      ),
    );

    yield* Effect.forkScoped(
      code.workspace.fileDeletes().pipe(
        Stream.runForEach((event) =>
          Effect.forEach(
            event.files,
            (uri) =>
              Effect.gen(function* () {
                const notebookUri = yield* decodeNotebookId(uri.toString());
                const session = yield* sessions.find(notebookUri);
                if (Option.isNone(session)) return;
                const open = yield* code.workspace.getNotebookDocuments();
                if (
                  open.some(
                    (document) => document.uri.toString() === notebookUri,
                  )
                ) {
                  deletedWhileOpen.add(notebookUri);
                  return;
                }
                yield* sessions.shutdown(notebookUri);
              }).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      ),
    );

    yield* Effect.forkScoped(
      code.workspace.notebookDocumentClosed().pipe(
        Stream.runForEach((document) =>
          Effect.gen(function* () {
            const uri = document.uri.toString();
            if (!deletedWhileOpen.delete(uri)) return;
            const notebookUri = yield* decodeNotebookId(uri);
            yield* sessions.shutdown(notebookUri);
          }).pipe(Effect.ignore),
        ),
      ),
    );
  }),
);
