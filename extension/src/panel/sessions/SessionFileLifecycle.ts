import { Effect, Layer, Schema, Stream } from "effect";
import type * as vscode from "vscode";

import { VsCode } from "../../platform/VsCode.ts";
import { NotebookIdFromString } from "../../schemas/MarimoNotebookDocument.ts";
import { SessionsService } from "./SessionsService.ts";

const decodeNotebookId = Schema.decodeUnknownEffect(NotebookIdFromString);

function descendantSuffix(
  root: vscode.Uri,
  candidate: vscode.Uri,
): string | undefined {
  if (
    root.scheme !== candidate.scheme ||
    root.authority !== candidate.authority
  ) {
    return undefined;
  }
  const rootPath = root.path.endsWith("/") ? root.path.slice(0, -1) : root.path;
  if (candidate.path === rootPath) return "";
  const prefix = rootPath === "" ? "/" : `${rootPath}/`;
  return candidate.path.startsWith(prefix)
    ? candidate.path.slice(rootPath.length)
    : undefined;
}

/** Rebase a notebook URI when its file or an ancestor directory is renamed. */
export function rebaseNotebookUri(
  notebook: vscode.Uri,
  oldUri: vscode.Uri,
  newUri: vscode.Uri,
): string | undefined {
  const suffix = descendantSuffix(oldUri, notebook);
  if (suffix === undefined) return undefined;
  const newPath = newUri.path.endsWith("/")
    ? newUri.path.slice(0, -1)
    : newUri.path;
  return notebook
    .with({
      scheme: newUri.scheme,
      authority: newUri.authority,
      path: `${newPath}${suffix}`,
    })
    .toString();
}

/** Whether a URI names the notebook itself or one of its ancestor directories. */
export function containsNotebookUri(
  parent: vscode.Uri,
  notebook: vscode.Uri,
): boolean {
  return descendantSuffix(parent, notebook) !== undefined;
}

/** Keeps live sessions aligned with notebook file rename and deletion events. */
export const SessionFileLifecycleLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const sessions = yield* SessionsService;
    const deletedWhileOpen = new Set<string>();

    yield* Effect.forkScoped(
      code.workspace.fileRenames.pipe(
        Stream.runForEach((event) =>
          Effect.forEach(
            event.files,
            ({ oldUri, newUri }) =>
              Effect.gen(function* () {
                const live = yield* sessions.get;
                for (const session of live) {
                  const rebased = rebaseNotebookUri(
                    code.Uri.parse(session.notebookUri),
                    oldUri,
                    newUri,
                  );
                  if (rebased === undefined) continue;
                  const newNotebookUri = yield* decodeNotebookId(rebased);
                  yield* sessions.move(session.notebookUri, newNotebookUri);
                  if (deletedWhileOpen.delete(session.notebookUri)) {
                    deletedWhileOpen.add(newNotebookUri);
                  }
                }
              }).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      ),
    );

    yield* Effect.forkScoped(
      code.workspace.fileDeletes.pipe(
        Stream.runForEach((event) =>
          Effect.forEach(
            event.files,
            (uri) =>
              Effect.gen(function* () {
                const live = yield* sessions.get;
                const open = yield* code.workspace.getNotebookDocuments;
                for (const session of live) {
                  if (
                    !containsNotebookUri(
                      uri,
                      code.Uri.parse(session.notebookUri),
                    )
                  ) {
                    continue;
                  }
                  if (
                    open.some(
                      (document) =>
                        document.uri.toString() === session.notebookUri,
                    )
                  ) {
                    deletedWhileOpen.add(session.notebookUri);
                    continue;
                  }
                  yield* sessions.shutdown(session.notebookUri);
                }
              }).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      ),
    );

    yield* Effect.forkScoped(
      code.workspace.notebookDocumentClosed.pipe(
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
