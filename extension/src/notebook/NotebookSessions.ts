import { Deferred, Effect, Option, Stream } from "effect";
import type * as vscode from "vscode";

import type { VsCode } from "../platform/VsCode.ts";
import {
  MarimoNotebookDocument,
  type NotebookId,
} from "../schemas/MarimoNotebookDocument.ts";

export interface NotebookSession {
  readonly document?: vscode.NotebookDocument;
  readonly invalidated: Deferred.Deferred<void>;
}

export interface OpenNotebookSession extends NotebookSession {
  readonly document: vscode.NotebookDocument;
}

export function isOpenNotebookSession(
  session: NotebookSession | undefined,
): session is OpenNotebookSession {
  return session?.document !== undefined;
}

/**
 * Tracks notebook sessions by document identity, not URI alone.
 *
 * The Deferred is both a typed, unique session identity and a signal that
 * session-scoped work can await. Replacing or closing a document completes the
 * old Deferred before notifying the owner to discard its per-notebook state.
 */
export function makeNotebookSessions<E, R>(
  code: VsCode,
  onInvalidate: (notebookId: NotebookId) => Effect.Effect<void, E, R>,
) {
  return Effect.gen(function* () {
    const sessions = new Map<NotebookId, NotebookSession>();

    const sessionFor = Effect.fn(function* (notebookId: NotebookId) {
      const existing = sessions.get(notebookId);
      if (existing) return existing;

      const session = { invalidated: yield* Deferred.make<void>() };
      sessions.set(notebookId, session);
      return session;
    });

    const invalidate = Effect.fn(function* (notebookId: NotebookId) {
      const current = sessions.get(notebookId);
      const replacement: NotebookSession = {
        ...(current?.document ? { document: current.document } : {}),
        invalidated: yield* Deferred.make<void>(),
      };
      sessions.set(notebookId, replacement);
      if (current) {
        yield* Deferred.succeed(current.invalidated, undefined);
      }
      yield* onInvalidate(notebookId);
    });

    const markOpen = Effect.fn(function* (document: vscode.NotebookDocument) {
      const notebook = MarimoNotebookDocument.tryFrom(document);
      if (Option.isNone(notebook)) return;

      const existing = sessions.get(notebook.value.id);
      if (existing?.document === document) return;

      const replacement: NotebookSession = {
        document,
        invalidated: yield* Deferred.make<void>(),
      };
      sessions.set(notebook.value.id, replacement);
      if (existing) {
        yield* Deferred.succeed(existing.invalidated, undefined);
        yield* onInvalidate(notebook.value.id);
      }
    });

    // Subscribe before the initial snapshot so an open cannot fall through
    // the gap. Re-observing the same document object is idempotent.
    yield* Effect.forkScoped(
      code.workspace.notebookDocumentOpened().pipe(Stream.runForEach(markOpen)),
    );
    for (const document of yield* code.workspace.getNotebookDocuments()) {
      yield* markOpen(document);
    }

    yield* Effect.forkScoped(
      code.workspace.notebookDocumentClosed().pipe(
        Stream.runForEach((document) => {
          const notebook = MarimoNotebookDocument.tryFrom(document);
          if (Option.isNone(notebook)) return Effect.void;

          const current = sessions.get(notebook.value.id);
          // A delayed close for an older document must not invalidate a
          // replacement document opened at the same URI.
          if (current?.document && current.document !== document) {
            return Effect.void;
          }

          sessions.delete(notebook.value.id);
          return Effect.gen(function* () {
            if (current) {
              yield* Deferred.succeed(current.invalidated, undefined);
            }
            yield* onInvalidate(notebook.value.id);
          });
        }),
      ),
    );

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        sessions.values(),
        (session) => Deferred.succeed(session.invalidated, undefined),
        { discard: true },
      ),
    );

    return {
      current: (notebookId: NotebookId) => sessions.get(notebookId),
      invalidate,
      sessionFor,
    } as const;
  });
}
