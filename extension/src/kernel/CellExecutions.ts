import {
  Cause,
  Context,
  Data,
  Effect,
  Equal,
  Exit,
  Fiber,
  HashMap,
  HashSet,
  Layer,
  Option,
  Queue,
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
  extractCellIdFromCellMessage,
  MarimoNotebookCell,
  MarimoNotebookDocument,
  type NotebookCellId,
  type NotebookId,
} from "../schemas/MarimoNotebookDocument.ts";
import type { CellOperationNotification } from "../types.ts";
import {
  acceptKernelState,
  activeRunId,
  AcceptedSource,
  CellCommand,
  type CellRunState,
  makeCellRunState,
  Op,
  parseOp,
  RunId,
  runIdFromWire,
  step,
  transitionCell,
} from "./CellRunReducer.ts";

/** Stable identity of one cell whose commands can be presented. */
export interface CellRef {
  readonly notebookId: NotebookId;
  readonly cellId: NotebookCellId;
}

/** Effectful capability supplied by a host presentation adapter. */
export type Drive = (
  cell: CellRef,
  command: CellCommand,
) => Effect.Effect<void>;

interface DriveBinding {
  readonly runId: RunId;
  readonly value: Drive;
}

interface CellRecord {
  readonly run: CellRunState;
  readonly drive: Option.Option<DriveBinding>;
}

export class RunCorrelationError extends Data.TaggedError(
  "RunCorrelationError",
)<{
  readonly cellId: NotebookCellId;
  readonly expectedRunId: Option.Option<RunId>;
  readonly receivedRunId: Option.Option<RunId>;
  readonly status: CellOperationNotification["status"];
  /**
   * `superseded-run`: a tagged operation named a run other than the active
   * one. `untracked-queue`: a queued operation carried no run id at all, so
   * no run can be opened for it.
   */
  readonly reason: "superseded-run" | "untracked-queue";
}> {}

export interface CellStaleness {
  readonly current: Effect.Effect<HashSet.HashSet<NotebookCellId>>;
  /** Emits the current set immediately, followed by changed sets. */
  readonly changes: Stream.Stream<HashSet.HashSet<NotebookCellId>>;
}

/** Stable session binding whose current presentation may change over time. */
export interface NotebookExecutionBinding {
  readonly getDrive: Effect.Effect<Option.Option<Drive>>;
}

export interface NotebookExecutions {
  /**
   * Folds one Wire Cell Operation, then admits its presentation commands when
   * its run correlates. Completion does not wait for the presentation adapter.
   */
  readonly apply: (
    operation: CellOperationNotification,
  ) => Effect.Effect<void, RunCorrelationError>;
  readonly interrupt: Effect.Effect<void>;
  readonly invalidate: Effect.Effect<void>;
  readonly remove: (cellId: NotebookCellId) => Effect.Effect<void>;
  readonly submit: <A, E, R>(
    cells: ReadonlyArray<{
      readonly cellId: NotebookCellId;
      readonly source: string;
    }>,
    send: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly staleCells: CellStaleness;
}

interface CellSource {
  readonly cellId: NotebookCellId;
  readonly source: string;
}

interface NotebookEntry {
  readonly session: NotebookDocumentSession;
  readonly executions: NotebookExecutions;
  readonly updateSources: (
    sources: ReadonlyArray<CellSource>,
  ) => Effect.Effect<void>;
}

interface SubmittedSource {
  readonly token: symbol;
  readonly source: string;
}

interface Work {
  readonly cell: CellRef;
  readonly command: CellCommand;
  readonly drive: Option.Option<Drive>;
}

const cellRef = (notebookId: NotebookId, cellId: NotebookCellId): CellRef => ({
  notebookId,
  cellId,
});

/** The drive bound when the given run opened, if the record still holds it. */
const boundDrive = (record: CellRecord, runId: RunId): Option.Option<Drive> =>
  Option.filter(record.drive, (binding) => binding.runId === runId).pipe(
    Option.map((binding) => binding.value),
  );

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
        const records = new Map<NotebookCellId, CellRecord>();
        const submittedSources = new Map<
          NotebookCellId,
          Array<SubmittedSource>
        >();
        const currentSources = new Map<NotebookCellId, string>();
        for (const cell of notebook.getCells()) {
          if (Option.isSome(cell.id)) {
            currentSources.set(cell.id.value, cell.document.getText());
          }
        }
        const staleRef = yield* SubscriptionRef.make(
          HashSet.empty<NotebookCellId>(),
        );
        const ordering = Semaphore.makeUnsafe(1);
        const scope = yield* Effect.scope;
        const presentationScope = yield* Scope.fork(scope);
        const presentation = yield* Queue.unbounded<Work, Cause.Done>();
        let closed = false;

        const publishStale = (next: HashSet.HashSet<NotebookCellId>) =>
          Effect.gen(function* () {
            const current = yield* SubscriptionRef.get(staleRef);
            if (Equal.equals(current, next)) return;
            yield* SubscriptionRef.set(staleRef, next);
            yield* SubscriptionRef.update(allStaleCells, (all) =>
              HashMap.set(all, notebookId, next),
            );
          });

        const isStale = (cellId: NotebookCellId): boolean => {
          const record = records.get(cellId);
          if (record === undefined) return false;
          return AcceptedSource.$match(record.run.acceptedSource, {
            Unknown: () => false,
            Invalidated: () => true,
            Accepted: ({ source }) => {
              const currentSource = currentSources.get(cellId);
              return currentSource !== undefined && source !== currentSource;
            },
          });
        };

        const refreshStale = (cellIds: Iterable<NotebookCellId>) =>
          Effect.gen(function* () {
            let next = yield* SubscriptionRef.get(staleRef);
            for (const cellId of cellIds) {
              next = isStale(cellId)
                ? HashSet.add(next, cellId)
                : HashSet.remove(next, cellId);
            }
            yield* publishStale(next);
          });

        const updateSources = (sources: ReadonlyArray<CellSource>) =>
          ordering.withPermit(
            Effect.gen(function* () {
              if (closed) return;
              for (const { cellId, source } of sources) {
                currentSources.set(cellId, source);
              }
              yield* refreshStale(sources.map(({ cellId }) => cellId));
            }),
          );

        const drive = ({ cell, command, drive: target }: Work) =>
          Option.match(target, {
            onNone: () =>
              Effect.logDebug(
                "Cell run has no presentation; skipping command",
              ).pipe(
                Effect.annotateLogs({
                  ...cell,
                  command: command._tag,
                  ...("runId" in command ? { runId: command.runId } : {}),
                }),
              ),
            onSome: (apply) =>
              apply(cell, command).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterrupts(cause)
                    ? Effect.failCause(cause)
                    : Effect.logWarning("Failed to drive cell command").pipe(
                        Effect.annotateLogs({
                          cause,
                          ...cell,
                          command: command._tag,
                          ...("runId" in command
                            ? { runId: command.runId }
                            : {}),
                        }),
                      ),
                ),
              ),
          });

        const driveBatch = (batch: ReadonlyArray<Work>) => {
          // Preserve every lifecycle command, but project only the newest
          // output pending for each cell while the previous batch was driven.
          const newestOutput = new Map<NotebookCellId, number>();
          for (const [index, work] of batch.entries()) {
            if (work.command._tag === "RenderOutputs") {
              newestOutput.set(work.cell.cellId, index);
            }
          }

          return Effect.forEach(
            batch,
            (work, index) =>
              work.command._tag === "RenderOutputs" &&
              newestOutput.get(work.cell.cellId) !== index
                ? Effect.void
                : drive(work),
            { discard: true },
          );
        };

        const presentationWorker = yield* Stream.fromQueue(presentation).pipe(
          Stream.runForEachArray(driveBatch),
          Effect.forkIn(presentationScope),
        );

        const present = (work: Work) =>
          Queue.offer(presentation, work).pipe(
            Effect.flatMap((admitted) =>
              admitted
                ? Effect.void
                : Effect.die("Cell presentation is closed"),
            ),
          );

        const correlationError = (
          record: CellRecord,
          wire: CellOperationNotification,
        ): Option.Option<RunCorrelationError> => {
          const cellId = extractCellIdFromCellMessage(wire);
          const expectedRunId = activeRunId(record.run.phase);
          const receivedRunId = runIdFromWire(wire.run_id);
          if (
            wire.status !== "queued" &&
            Option.isSome(receivedRunId) &&
            !Equal.equals(expectedRunId, receivedRunId)
          ) {
            return Option.some(
              new RunCorrelationError({
                cellId,
                expectedRunId,
                receivedRunId,
                status: wire.status,
                reason: "superseded-run",
              }),
            );
          }
          return Option.none();
        };

        const dequeueSubmittedSource = Effect.fn(
          "CellExecutions.dequeueSubmittedSource",
        )((cellId: NotebookCellId) =>
          Effect.sync(() => {
            const pending = submittedSources.get(cellId);
            if (pending === undefined || pending.length === 0) {
              return Option.none<string>();
            }
            const submitted = pending.shift();
            if (pending.length === 0) {
              submittedSources.delete(cellId);
            }
            return Option.fromNullishOr(submitted).pipe(
              Option.map(({ source }) => source),
            );
          }),
        );

        const apply: NotebookExecutions["apply"] = (wire) =>
          ordering.withPermit(
            Effect.gen(function* () {
              if (closed) return;
              const cellId = extractCellIdFromCellMessage(wire);
              const record = records.get(cellId) ?? {
                run: makeCellRunState(cellId),
                drive: Option.none<DriveBinding>(),
              };
              const next = transitionCell(record.run.state, wire);
              const retainKernelState = Effect.gen(function* () {
                if (wire.status === "queued") {
                  yield* dequeueSubmittedSource(cellId);
                }
                // Keep kernel-owned state even when this operation cannot
                // drive a host run. Lazy execution tags descendant staleness
                // with the ancestor's run ID; late console appends likewise
                // arrive after their presentation run has closed.
                records.set(cellId, {
                  ...record,
                  run: acceptKernelState(record.run, next),
                });
                yield* refreshStale([cellId]);
              });
              const op = yield* Option.match(
                parseOp(next, wire, RunId(crypto.randomUUID())),
                {
                  onNone: () =>
                    retainKernelState.pipe(
                      Effect.andThen(
                        Effect.fail(
                          new RunCorrelationError({
                            cellId,
                            expectedRunId: activeRunId(record.run.phase),
                            receivedRunId: Option.none(),
                            status: wire.status,
                            reason: "untracked-queue",
                          }),
                        ),
                      ),
                    ),
                  onSome: Effect.succeed,
                },
              );
              let source = Option.none<string>();
              if (Op.$is("Queue")(op)) {
                const submittedSource = yield* dequeueSubmittedSource(cellId);
                source = submittedSource.pipe(
                  Option.orElse(() =>
                    Option.fromNullishOr(currentSources.get(cellId)),
                  ),
                );
              }

              const result = step(record.run, op, source);
              const mismatch = correlationError(record, wire);
              const enforceCorrelation =
                Option.isSome(mismatch) && result.commands.length > 0
                  ? retainKernelState.pipe(
                      Effect.andThen(Effect.fail(mismatch.value)),
                    )
                  : Effect.void;
              yield* enforceCorrelation;
              if (
                wire.status === "idle" &&
                Option.isNone(activeRunId(record.run.phase))
              ) {
                yield* dequeueSubmittedSource(cellId);
              }
              const currentDrive = yield* binding.getDrive;
              // A run's presentation stays on the drive that opened it:
              // OpenRun binds the drive current at open time, and later
              // commands for that run reuse the binding even after the
              // controller changes or detaches.
              const opened = new Set<RunId>();
              for (const command of result.commands) {
                if (command._tag === "OpenRun") opened.add(command.runId);
              }
              const driveForRun = (runId: RunId): Option.Option<Drive> =>
                boundDrive(record, runId).pipe(
                  Option.orElse(() =>
                    opened.has(runId) ? currentDrive : Option.none(),
                  ),
                );
              const phase = result.entry.phase;
              const runId = activeRunId(phase);
              records.set(cellId, {
                run: result.entry,
                drive: runId.pipe(
                  Option.flatMap((runId) =>
                    driveForRun(runId).pipe(
                      Option.map((value) => ({
                        runId,
                        value,
                      })),
                    ),
                  ),
                ),
              });
              yield* refreshStale([cellId]);

              const cell = cellRef(notebookId, cellId);
              for (const command of result.commands) {
                yield* present({
                  cell,
                  command,
                  drive:
                    command._tag === "OpenRun" ||
                    command._tag === "SetDiagnostic"
                      ? currentDrive
                      : driveForRun(command.runId),
                });
              }
            }).pipe(
              Effect.annotateLogs({
                notebookId,
                cellId: extractCellIdFromCellMessage(wire),
              }),
            ),
          );

        const release = (
          target: (cellId: NotebookCellId) => boolean,
          remove: boolean,
          operation: Op = Op.Interrupt(),
        ) =>
          Effect.gen(function* () {
            const released: NotebookCellId[] = [];
            for (const [cellId, record] of records) {
              if (!target(cellId)) continue;
              released.push(cellId);
              const result = step(record.run, operation);
              const cell = cellRef(notebookId, cellId);
              for (const command of result.commands) {
                yield* present({
                  cell,
                  command,
                  drive:
                    command._tag === "OpenRun" ||
                    command._tag === "SetDiagnostic"
                      ? Option.none()
                      : boundDrive(record, command.runId),
                });
              }
              if (remove) {
                records.delete(cellId);
              } else {
                records.set(cellId, {
                  run: result.entry,
                  drive: Option.none(),
                });
              }
            }
            yield* refreshStale(released);
          });

        const interrupt = ordering.withPermit(
          Effect.gen(function* () {
            if (closed) return;
            submittedSources.clear();
            yield* release(() => true, false);
          }),
        );

        const invalidate = ordering.withPermit(
          Effect.gen(function* () {
            if (closed) return;
            submittedSources.clear();
            yield* release(() => true, false, Op.Invalidate());
          }),
        );

        const remove = (cellId: NotebookCellId) =>
          ordering.withPermit(
            Effect.gen(function* () {
              if (closed) return;
              yield* release((candidate) => candidate === cellId, true);
              currentSources.delete(cellId);
              submittedSources.delete(cellId);
              yield* refreshStale([cellId]);
            }),
          );

        const submit: NotebookExecutions["submit"] = (cells, send) => {
          const token = Symbol("cell submission");
          const register = ordering.withPermit(
            Effect.sync(() => {
              for (const { cellId, source } of cells) {
                const pending = submittedSources.get(cellId) ?? [];
                pending.push({ token, source });
                submittedSources.set(cellId, pending);
              }
            }),
          );
          const rollback = ordering.withPermit(
            Effect.sync(() => {
              for (const { cellId } of cells) {
                const pending = submittedSources.get(cellId);
                if (pending === undefined) continue;
                const remaining = pending.filter(
                  (submitted) => submitted.token !== token,
                );
                if (remaining.length === 0) submittedSources.delete(cellId);
                else submittedSources.set(cellId, remaining);
              }
            }),
          );
          return register.pipe(
            Effect.andThen(send),
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : rollback,
            ),
          );
        };

        const cleanup = Effect.uninterruptible(
          ordering.withPermit(
            Effect.gen(function* () {
              if (closed) return;
              closed = true;
              yield* release(() => true, true);
              yield* Queue.end(presentation);
              yield* Fiber.join(presentationWorker);
              submittedSources.clear();
              currentSources.clear();
              yield* SubscriptionRef.set(staleRef, HashSet.empty());
              yield* SubscriptionRef.update(allStaleCells, (all) =>
                HashMap.remove(all, notebookId),
              );
            }),
          ),
        );
        yield* Scope.addFinalizer(presentationScope, cleanup);

        const executions: NotebookExecutions = {
          apply,
          interrupt,
          invalidate,
          remove,
          submit,
          staleCells: {
            current: SubscriptionRef.get(staleRef),
            changes: SubscriptionRef.changes(staleRef),
          },
        };
        return { executions, updateSources } as const;
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
