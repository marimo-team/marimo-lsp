import {
  Context,
  Data,
  Effect,
  Exit,
  HashMap,
  Layer,
  Option,
  PubSub,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import type * as vscode from "vscode";

import * as VsCode from "../platform/VsCode.ts";
import type { NotebookLifecycleEvent } from "../platform/Workspace.ts";
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
export interface Session {
  readonly id: NotebookDocumentSessionId;
  readonly notebookId: NotebookId;
  readonly document: vscode.NotebookDocument;
  /** Lifetime of work and resources tied to this exact document opening. */
  readonly scope: Scope.Scope;
}

export class EndedError extends Data.TaggedError(
  "NotebookDocumentSessions.EndedError",
)<{ readonly notebookId: NotebookId }> {}

export interface Interface {
  readonly current: (notebookId: NotebookId) => Option.Option<Session>;
  readonly forDocument: (
    document: vscode.NotebookDocument,
  ) => Option.Option<Session>;
  readonly active: Stream.Stream<Option.Option<Session>>;
  /** Events observed after the document transition and its finalizers complete. */
  readonly subscribeLifecycle: Effect.Effect<
    Stream.Stream<NotebookLifecycleEvent>,
    never,
    Scope.Scope
  >;
}

interface SessionEntry {
  readonly session: Session;
  readonly scope: Scope.Closeable;
}

type InstallResult = Data.TaggedEnum<{
  Existing: { readonly current: SessionEntry };
  Installed: { readonly displaced: SessionEntry | undefined };
}>;
const InstallResult = Data.taggedEnum<InstallResult>();

/** Tracks the current document session for each notebook URI. */
export class Service extends Context.Service<Service, Interface>()(
  "@marimo/NotebookDocumentSessions",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const code = yield* VsCode.Service;
    const serviceScope = yield* Effect.scope;
    const sessions = yield* SubscriptionRef.make(
      HashMap.empty<NotebookId, SessionEntry>(),
    );
    const lifecycleChanges = yield* PubSub.unbounded<NotebookLifecycleEvent>();

    const end = Effect.fn("NotebookDocumentSessions.end")(function* (
      entry: SessionEntry,
    ) {
      yield* Scope.close(entry.scope, Exit.void);
    });

    const markOpen = Effect.fn("NotebookDocumentSessions.markOpen")(function* (
      document: vscode.NotebookDocument,
    ) {
      // The lifecycle replay can deliver an opened event for a document
      // that was since closed or replaced at the same URI; a closed
      // document never starts a session.
      if (document.isClosed) return undefined;
      const notebook = MarimoNotebookDocument.tryFrom(document);
      if (notebook._tag === "None") return undefined;

      const scope = yield* Scope.fork(serviceScope, "parallel");
      const session: Session = {
        id: makeNotebookDocumentSessionId(),
        notebookId: notebook.value.id,
        document,
        scope,
      };
      const candidate: SessionEntry = { session, scope };
      const result = yield* SubscriptionRef.modify(
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
      return session;
    });

    const markClosed = Effect.fn("NotebookDocumentSessions.markClosed")(
      function* (document: vscode.NotebookDocument) {
        const notebook = MarimoNotebookDocument.tryFrom(document);
        if (notebook._tag === "None") return;

        const removed = yield* SubscriptionRef.modify(sessions, (current) => {
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
          (event.type === "opened"
            ? markOpen(event.document)
            : markClosed(event.document)
          ).pipe(Effect.andThen(PubSub.publish(lifecycleChanges, event))),
        ),
      ),
    );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.getAndSet(
          sessions,
          HashMap.empty<NotebookId, SessionEntry>(),
        );
        yield* Effect.forEach(HashMap.values(current), end, {
          discard: true,
        });
      }),
    );

    const current = (notebookId: NotebookId) =>
      Option.map(
        HashMap.get(SubscriptionRef.getUnsafe(sessions), notebookId),
        (entry) => entry.session,
      );

    const forDocument = (document: vscode.NotebookDocument) => {
      const notebook = MarimoNotebookDocument.tryFrom(document);
      return Option.flatMap(notebook, ({ id }) =>
        Option.filter(current(id), (session) => session.document === document),
      );
    };
    const active = Stream.merge(
      code.window.activeNotebookEditorChanges.pipe(Stream.map(() => undefined)),
      SubscriptionRef.changes(sessions).pipe(Stream.map(() => undefined)),
    ).pipe(
      Stream.mapEffect(() => code.window.getActiveNotebookEditor),
      Stream.map(Option.flatMap((editor) => forDocument(editor.notebook))),
      Stream.changesWith((left, right) =>
        Option.isNone(left)
          ? Option.isNone(right)
          : Option.isSome(right) && left.value.id === right.value.id,
      ),
    );

    return Service.of({
      current,
      forDocument,
      /** The current document session for VS Code's active notebook editor. */
      active,
      subscribeLifecycle: PubSub.subscribe(lifecycleChanges).pipe(
        Effect.map(Stream.fromSubscription),
      ),
    });
  }),
);
