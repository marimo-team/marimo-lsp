import {
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Layer,
  PubSub,
  Scope,
  Stream,
} from "effect";
import type * as vscode from "vscode";

import { VsCode } from "../platform/VsCode.ts";
import {
  MarimoNotebookDocument,
  type NotebookId,
} from "../schemas/MarimoNotebookDocument.ts";
import {
  makeNotebookDocumentSessionId,
  type NotebookDocumentSessionId,
} from "../schemas/SessionIds.ts";

export type { NotebookDocumentSessionId } from "../schemas/SessionIds.ts";

/**
 * One opening of a marimo notebook document.
 *
 * Reopening the same URI starts a new session.
 */
export interface NotebookDocumentSession {
  readonly id: NotebookDocumentSessionId;
  readonly notebookId: NotebookId;
  readonly document: vscode.NotebookDocument;
  readonly ended: Effect.Effect<void>;
  /** Lifetime of work owned by this opening of the document. */
  readonly scope: Scope.Scope;
}

export type NotebookDocumentSessionChange =
  | {
      readonly _tag: "Opened";
      readonly session: NotebookDocumentSession;
    }
  | {
      readonly _tag: "Ended";
      readonly session: NotebookDocumentSession;
    };

export class NotebookDocumentSessionEndedError extends Data.TaggedError(
  "NotebookDocumentSessionEndedError",
)<{ readonly notebookId: NotebookId }> {}

interface SessionEntry {
  readonly session: NotebookDocumentSession;
  readonly end: Deferred.Deferred<void>;
  readonly scope: Scope.Closeable;
}

/** Tracks the current document session for each notebook URI. */
export class NotebookDocumentSessions extends Context.Service<NotebookDocumentSessions>()(
  "NotebookDocumentSessions",
  {
    make: Effect.gen(function* () {
      const code = yield* VsCode;
      const serviceScope = yield* Effect.scope;
      const sessions = new Map<NotebookId, SessionEntry>();
      const changes = yield* PubSub.unbounded<NotebookDocumentSessionChange>();

      const end = Effect.fn(function* (entry: SessionEntry) {
        yield* Deferred.succeed(entry.end, undefined);
        yield* Scope.close(entry.scope, Exit.void);
        const change: NotebookDocumentSessionChange = {
          _tag: "Ended",
          session: entry.session,
        };
        yield* PubSub.publish(changes, change);
      });

      const markOpen = Effect.fn(function* (document: vscode.NotebookDocument) {
        // The lifecycle replay can deliver an opened event for a document
        // that was since closed or replaced at the same URI; a closed
        // document never starts a session.
        if (document.isClosed) return undefined;
        const notebook = MarimoNotebookDocument.tryFrom(document);
        if (notebook._tag === "None") return undefined;

        const existing = sessions.get(notebook.value.id);
        if (existing?.session.document === document) return existing.session;

        const ended = yield* Deferred.make<void>();
        const scope = yield* Scope.fork(serviceScope, "parallel");
        const session: NotebookDocumentSession = {
          id: makeNotebookDocumentSessionId(),
          notebookId: notebook.value.id,
          document,
          ended: Deferred.await(ended),
          scope,
        };
        sessions.set(notebook.value.id, { session, end: ended, scope });

        if (existing) yield* end(existing);
        const change: NotebookDocumentSessionChange = {
          _tag: "Opened",
          session,
        };
        yield* PubSub.publish(changes, change);
        return session;
      });

      const markClosed = Effect.fn(function* (
        document: vscode.NotebookDocument,
      ) {
        const notebook = MarimoNotebookDocument.tryFrom(document);
        if (notebook._tag === "None") return;

        const current = sessions.get(notebook.value.id);
        if (current?.session.document !== document) return;

        sessions.delete(notebook.value.id);
        yield* end(current);
      });

      const lifecycle = yield* code.workspace.subscribeNotebookLifecycle;
      const openDocuments = yield* code.workspace.getNotebookDocuments;
      yield* Effect.forEach(openDocuments, markOpen, { discard: true });
      yield* Effect.forkScoped(
        lifecycle.pipe(
          Stream.runForEach((event) =>
            event.type === "opened"
              ? markOpen(event.document)
              : markClosed(event.document),
          ),
        ),
      );

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.forEach(sessions.values(), end, { discard: true });
          yield* PubSub.shutdown(changes);
        }),
      );

      return {
        current: (notebookId: NotebookId) => sessions.get(notebookId)?.session,
        forDocument(document: vscode.NotebookDocument) {
          const notebook = MarimoNotebookDocument.tryFrom(document);
          if (notebook._tag === "None") return undefined;
          const session = sessions.get(notebook.value.id)?.session;
          return session?.document === document ? session : undefined;
        },
        changes: Stream.fromPubSub(changes),
      } as const;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
