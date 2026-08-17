import { Context, Data, Deferred, Effect, Layer, PubSub, Stream } from "effect";
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
}

/** Tracks the current document session for each notebook URI. */
export class NotebookDocumentSessions extends Context.Service<NotebookDocumentSessions>()(
  "NotebookDocumentSessions",
  {
    make: Effect.gen(function* () {
      const code = yield* VsCode;
      const sessions = new Map<NotebookId, SessionEntry>();
      const changes = yield* PubSub.unbounded<NotebookDocumentSessionChange>();

      const end = (entry: SessionEntry) => {
        Deferred.doneUnsafe(entry.end, Effect.void);
        const change: NotebookDocumentSessionChange = {
          _tag: "Ended",
          session: entry.session,
        };
        PubSub.publishUnsafe(changes, change);
      };

      const markOpen = (document: vscode.NotebookDocument) => {
        const notebook = MarimoNotebookDocument.tryFrom(document);
        if (notebook._tag === "None") return undefined;

        const existing = sessions.get(notebook.value.id);
        if (existing?.session.document === document) return existing.session;

        const ended = Deferred.makeUnsafe<void>();
        const session: NotebookDocumentSession = {
          id: makeNotebookDocumentSessionId(),
          notebookId: notebook.value.id,
          document,
          ended: Deferred.await(ended),
        };
        sessions.set(notebook.value.id, { session, end: ended });

        if (existing) end(existing);
        const change: NotebookDocumentSessionChange = {
          _tag: "Opened",
          session,
        };
        PubSub.publishUnsafe(changes, change);
        return session;
      };

      const markClosed = (document: vscode.NotebookDocument) => {
        const notebook = MarimoNotebookDocument.tryFrom(document);
        if (notebook._tag === "None") return;

        const current = sessions.get(notebook.value.id);
        if (current?.session.document !== document) return;

        sessions.delete(notebook.value.id);
        end(current);
      };

      const lifecycle = yield* code.workspace.subscribeNotebookLifecycle;
      const openDocuments = yield* code.workspace.getNotebookDocuments;
      for (const document of openDocuments) markOpen(document);
      yield* Effect.forkScoped(
        lifecycle.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() =>
              event.type === "opened"
                ? markOpen(event.document)
                : markClosed(event.document),
            ),
          ),
        ),
      );

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          for (const entry of sessions.values()) end(entry);
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
