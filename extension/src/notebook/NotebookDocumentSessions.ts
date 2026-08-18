import {
  Context,
  Data,
  Effect,
  Exit,
  HashMap,
  Layer,
  Option,
  PubSub,
  Ref,
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
  /** Lifetime of work and resources tied to this exact document opening. */
  readonly scope: Scope.Scope;
}

export type NotebookDocumentSessionChange = Data.TaggedEnum<{
  Opened: { readonly session: NotebookDocumentSession };
  Ended: { readonly session: NotebookDocumentSession };
}>;
export const NotebookDocumentSessionChange =
  Data.taggedEnum<NotebookDocumentSessionChange>();

export class NotebookDocumentSessionEndedError extends Data.TaggedError(
  "NotebookDocumentSessionEndedError",
)<{ readonly notebookId: NotebookId }> {}

interface SessionEntry {
  readonly session: NotebookDocumentSession;
  readonly scope: Scope.Closeable;
}

type InstallResult = Data.TaggedEnum<{
  Existing: { readonly current: SessionEntry };
  Installed: { readonly displaced: SessionEntry | undefined };
}>;
const InstallResult = Data.taggedEnum<InstallResult>();

/** Tracks the current document session for each notebook URI. */
export class NotebookDocumentSessions extends Context.Service<NotebookDocumentSessions>()(
  "NotebookDocumentSessions",
  {
    make: Effect.gen(function* () {
      const code = yield* VsCode;
      const serviceScope = yield* Effect.scope;
      const sessions = yield* Ref.make(
        HashMap.empty<NotebookId, SessionEntry>(),
      );
      const changes = yield* PubSub.unbounded<NotebookDocumentSessionChange>();

      const end = Effect.fn("NotebookDocumentSessions.end")(function* (
        entry: SessionEntry,
      ) {
        yield* Scope.close(entry.scope, Exit.void);
        yield* PubSub.publish(
          changes,
          NotebookDocumentSessionChange.Ended({
            session: entry.session,
          }),
        );
      });

      const markOpen = Effect.fn("NotebookDocumentSessions.markOpen")(
        function* (document: vscode.NotebookDocument) {
          // The lifecycle replay can deliver an opened event for a document
          // that was since closed or replaced at the same URI; a closed
          // document never starts a session.
          if (document.isClosed) return undefined;
          const notebook = MarimoNotebookDocument.tryFrom(document);
          if (notebook._tag === "None") return undefined;

          const scope = yield* Scope.fork(serviceScope, "parallel");
          const session: NotebookDocumentSession = {
            id: makeNotebookDocumentSessionId(),
            notebookId: notebook.value.id,
            document,
            scope,
          };
          const candidate: SessionEntry = { session, scope };
          const result = yield* Ref.modify(
            sessions,
            (
              current,
            ): readonly [
              InstallResult,
              HashMap.HashMap<NotebookId, SessionEntry>,
            ] => {
              const existing = HashMap.get(current, notebook.value.id);
              if (
                Option.isSome(existing) &&
                existing.value.session.document === document
              ) {
                return [
                  InstallResult.Existing({ current: existing.value }),
                  current,
                ];
              }
              return [
                InstallResult.Installed({
                  displaced: Option.getOrUndefined(existing),
                }),
                HashMap.set(current, notebook.value.id, candidate),
              ];
            },
          );

          if (InstallResult.$is("Existing")(result)) {
            yield* Scope.close(scope, Exit.void);
            return result.current.session;
          }

          if (result.displaced !== undefined) yield* end(result.displaced);
          yield* PubSub.publish(
            changes,
            NotebookDocumentSessionChange.Opened({ session }),
          );
          return session;
        },
      );

      const markClosed = Effect.fn("NotebookDocumentSessions.markClosed")(
        function* (document: vscode.NotebookDocument) {
          const notebook = MarimoNotebookDocument.tryFrom(document);
          if (notebook._tag === "None") return;

          const removed = yield* Ref.modify(sessions, (current) => {
            const entry = HashMap.get(current, notebook.value.id);
            if (
              Option.isNone(entry) ||
              entry.value.session.document !== document
            ) {
              return [Option.none<SessionEntry>(), current];
            }
            return [entry, HashMap.remove(current, notebook.value.id)];
          });
          if (Option.isSome(removed)) yield* end(removed.value);
        },
      );

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
          const current = yield* Ref.getAndSet(
            sessions,
            HashMap.empty<NotebookId, SessionEntry>(),
          );
          yield* Effect.forEach(HashMap.values(current), end, {
            discard: true,
          });
          yield* PubSub.shutdown(changes);
        }),
      );

      return {
        current: (notebookId: NotebookId) =>
          Option.getOrUndefined(
            HashMap.get(Ref.getUnsafe(sessions), notebookId),
          )?.session,
        forDocument(document: vscode.NotebookDocument) {
          const notebook = MarimoNotebookDocument.tryFrom(document);
          if (notebook._tag === "None") return undefined;
          const session = Option.getOrUndefined(
            HashMap.get(Ref.getUnsafe(sessions), notebook.value.id),
          )?.session;
          return session?.document === document ? session : undefined;
        },
        changes: Stream.fromPubSub(changes),
      } as const;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
