import {
  Context,
  Effect,
  Equal,
  HashMap,
  HashSet,
  Layer,
  Option,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import type * as vscode from "vscode";

import {
  type NotebookDocumentSession,
  NotebookDocumentSessionEndedError,
  NotebookDocumentSessions,
} from "../notebook/NotebookDocumentSessions.ts";
import { NotebookEditorRegistry } from "../notebook/NotebookEditorRegistry.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
  type NotebookCellId,
  type NotebookId,
} from "../schemas/MarimoNotebookDocument.ts";
import type { CellOutputReplay } from "../schemas/Models.gen.ts";
import type { CellOperationNotification } from "../types.ts";
import {
  type CellSource,
  type CellStalenessChange,
  DocumentExecutionSession,
  type Drive,
  RunCorrelationError,
} from "./DocumentExecutionSession.ts";

export { RunCorrelationError } from "./DocumentExecutionSession.ts";
export type { CellRef, Drive } from "./DocumentExecutionSession.ts";

export interface CellStaleness {
  /** Returns the cells currently considered stale. */
  readonly current: Effect.Effect<HashSet.HashSet<NotebookCellId>>;
  /** Emits the current set immediately, followed by changed sets. */
  readonly changes: Stream.Stream<HashSet.HashSet<NotebookCellId>>;
}

/** Stable session binding whose current presentation may change over time. */
export interface NotebookExecutionBinding {
  readonly getDrive: Effect.Effect<Option.Option<Drive>>;
}

/** Controls execution state for one exact notebook session. */
export interface NotebookExecutions {
  readonly apply: (
    operation: CellOperationNotification,
  ) => Effect.Effect<void, RunCorrelationError>;
  readonly restoreOutput: (replay: CellOutputReplay) => Effect.Effect<void>;
  readonly interrupt: Effect.Effect<void>;
  readonly invalidate: Effect.Effect<void>;
  readonly remove: (cellId: NotebookCellId) => Effect.Effect<void>;
  readonly submit: <A, E, R>(
    cells: ReadonlyArray<CellSource>,
    send: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly staleCells: CellStaleness;
}

interface NotebookEntry {
  readonly session: NotebookDocumentSession;
  readonly executions: NotebookExecutions;
  readonly updateSources: (
    sources: ReadonlyArray<CellSource>,
  ) => Effect.Effect<void>;
}

/** Owns one ordered collection of cell runs per exact notebook session. */
export class CellExecutions extends Context.Service<CellExecutions>()(
  "CellExecutions",
  {
    make: Effect.gen(function* () {
      const code = yield* VsCode;
      const editorRegistry = yield* NotebookEditorRegistry;
      const documentSessions = yield* NotebookDocumentSessions;
      const notebooks = new Map<NotebookId, NotebookEntry>();
      const opening = Semaphore.makeUnsafe(1);
      const allStaleCells = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, HashSet.HashSet<NotebookCellId>>(),
      );
      let staleContextValue: boolean | undefined;

      /** Updates VS Code's stale-cell context for the active notebook. */
      const updateStaleContext = Effect.fn("CellExecutions.updateStaleContext")(
        function* () {
          const activeNotebook = yield* editorRegistry.getActiveNotebookUri;
          const stale = yield* SubscriptionRef.get(allStaleCells);
          const hasStaleCells = Option.exists(activeNotebook, (notebookId) =>
            Option.exists(
              HashMap.get(stale, notebookId),
              (cells) => HashSet.size(cells) > 0,
            ),
          );
          if (hasStaleCells === staleContextValue) return;
          yield* code.commands.setContext(
            "marimo.notebook.hasStaleCells",
            hasStaleCells,
          );
          staleContextValue = hasStaleCells;
        },
      );

      yield* Effect.forkScoped(
        Stream.merge(
          SubscriptionRef.changes(allStaleCells).pipe(
            Stream.map(() => undefined),
          ),
          editorRegistry.streamActiveNotebookChanges.pipe(
            Stream.map(() => undefined),
          ),
        ).pipe(Stream.runForEach(updateStaleContext)),
      );
      yield* Effect.forkScoped(
        code.workspace.notebookDocumentChanges.pipe(
          Stream.filter(
            (event) =>
              event.cellChanges.some(
                (change) => change.document !== undefined,
              ) ||
              event.contentChanges.some(
                (change) => change.addedCells.length > 0,
              ),
          ),
          Stream.runForEach((event) => {
            const notebook = MarimoNotebookDocument.tryFrom(event.notebook);
            if (Option.isNone(notebook)) return Effect.void;
            const entry = notebooks.get(notebook.value.id);
            if (entry?.session.document !== event.notebook) return Effect.void;
            const sourceOf = (
              cell: vscode.NotebookCell,
              source: string,
            ): CellSource[] => {
              const marimoCell = MarimoNotebookCell.from(cell);
              return Option.match(marimoCell.id, {
                onNone: () => [],
                onSome: (cellId) => [{ cellId, source }],
              });
            };
            const sources = event.cellChanges.flatMap((change) => {
              const document = change.document;
              if (document === undefined) return [];
              return sourceOf(change.cell, document.getText());
            });
            const addedSources = event.contentChanges.flatMap((change) =>
              change.addedCells.flatMap((cell) =>
                sourceOf(cell, cell.document.getText()),
              ),
            );
            return entry.updateSources([...sources, ...addedSources]);
          }),
        ),
      );

      const makeNotebook = Effect.fn("CellExecutions.makeNotebook")(function* (
        notebook: MarimoNotebookDocument,
        binding: NotebookExecutionBinding,
      ) {
        const notebookId = notebook.id;
        const staleRef = yield* SubscriptionRef.make(
          HashSet.empty<NotebookCellId>(),
        );

        const publishStale = (changes: ReadonlyArray<CellStalenessChange>) =>
          Effect.gen(function* () {
            const current = yield* SubscriptionRef.get(staleRef);
            let next = current;
            for (const { cellId, stale } of changes) {
              next = stale
                ? HashSet.add(next, cellId)
                : HashSet.remove(next, cellId);
            }
            if (Equal.equals(current, next)) return;
            yield* SubscriptionRef.set(staleRef, next);
            yield* SubscriptionRef.update(allStaleCells, (all) =>
              HashMap.set(all, notebookId, next),
            );
          });

        const session = yield* DocumentExecutionSession.make({
          notebook,
          getDrive: binding.getDrive,
          onStaleChange: publishStale,
        });

        yield* Effect.addFinalizer(() =>
          session.close.pipe(
            Effect.andThen(session.drained),
            Effect.ensuring(
              SubscriptionRef.set(
                staleRef,
                HashSet.empty<NotebookCellId>(),
              ).pipe(
                Effect.andThen(
                  SubscriptionRef.update(allStaleCells, (all) =>
                    HashMap.remove(all, notebookId),
                  ),
                ),
              ),
            ),
          ),
        );

        const executions: NotebookExecutions = {
          apply: session.apply,
          restoreOutput: session.restoreOutput,
          interrupt: session.interrupt,
          invalidate: session.invalidate,
          remove: session.remove,
          submit: session.submit,
          staleCells: {
            current: SubscriptionRef.get(staleRef),
            changes: SubscriptionRef.changes(staleRef),
          },
        };
        return { executions, updateSources: session.updateSources } as const;
      });

      const open = Effect.fn("CellExecutions.open")(function (
        session: NotebookDocumentSession,
        binding: NotebookExecutionBinding,
      ) {
        return opening.withPermit(
          Effect.gen(function* () {
            const notebookId = session.notebookId;
            if (
              !Option.exists(
                documentSessions.current(notebookId),
                (current) => current === session,
              )
            ) {
              return yield* new NotebookDocumentSessionEndedError({
                notebookId,
              });
            }

            const existing = notebooks.get(notebookId);
            if (existing?.session === session) return existing.executions;

            const notebook = MarimoNotebookDocument.from(session.document);
            const made = yield* Effect.gen(function* () {
              const made = yield* makeNotebook(notebook, binding);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  if (notebooks.get(notebookId)?.session === session) {
                    notebooks.delete(notebookId);
                  }
                }),
              );
              return made;
            }).pipe(Scope.provide(session.scope));

            if (
              !Option.exists(
                documentSessions.current(notebookId),
                (current) => current === session,
              )
            ) {
              return yield* new NotebookDocumentSessionEndedError({
                notebookId,
              });
            }

            const entry: NotebookEntry = { session, ...made };
            notebooks.set(notebookId, entry);
            return made.executions;
          }),
        );
      });

      return {
        open,
        invalidate(notebookId: NotebookId) {
          return (
            notebooks.get(notebookId)?.executions.invalidate ?? Effect.void
          );
        },
        find(document: vscode.NotebookDocument) {
          const notebook = MarimoNotebookDocument.tryFrom(document);
          if (Option.isNone(notebook)) return Option.none<NotebookExecutions>();
          const entry = notebooks.get(notebook.value.id);
          return entry?.session.document === document
            ? Option.some(entry.executions)
            : Option.none<NotebookExecutions>();
        },
        get staleChanges() {
          return SubscriptionRef.changes(allStaleCells);
        },
      } as const;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([
      NotebookDocumentSessions.layer,
      NotebookEditorRegistry.layer,
    ]),
  );
}
