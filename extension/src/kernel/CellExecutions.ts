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
  type RunId,
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

interface CellExecutionState {
  readonly run: CellRunState;
  readonly editorSource: Option.Option<string>;
  readonly pendingSources: ReadonlyArray<SubmittedSource>;
}

type DocumentExecutionState = HashMap.HashMap<
  NotebookCellId,
  CellExecutionState
>;

interface CellTransition {
  readonly cellId: NotebookCellId;
  readonly current: CellRunState;
  readonly commands: ReadonlyArray<CellCommand>;
}

interface DocumentTransition {
  readonly state: DocumentExecutionState;
  readonly cells: ReadonlyArray<CellTransition>;
}

interface OperationTransition extends DocumentTransition {
  readonly error: Option.Option<RunCorrelationError>;
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
  /**
   * Folds one Wire Cell Operation, then admits its presentation commands when
   * its run correlates. Completion does not wait for the presentation adapter.
   */
  readonly apply: (
    operation: CellOperationNotification,
  ) => Effect.Effect<void, RunCorrelationError>;
  /** Interrupts every active run and clears pending submissions. */
  readonly interrupt: Effect.Effect<void>;
  /** Invalidates every cell and ends its active run. */
  readonly invalidate: Effect.Effect<void>;
  /** Removes a cell and its execution state. */
  readonly remove: (cellId: NotebookCellId) => Effect.Effect<void>;
  /** Tracks submitted sources while sending them to the kernel. */
  readonly submit: <A, E, R>(
    cells: ReadonlyArray<{
      readonly cellId: NotebookCellId;
      readonly source: string;
    }>,
    send: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** Exposes current and changing stale-cell state. */
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

/** Returns true when a command supersedes older pending output. */
const isConflatableOutput: (command: CellCommand) => boolean =
  CellCommand.$match({
    OpenRun: () => false,
    StartRun: () => false,
    RenderOutputs: () => true,
    CloseRun: () => false,
    PresentUntrackedError: () => true,
    SetDiagnostic: () => false,
  });

/** Selects the current or run-bound drive that owns a command. */
const selectCommandDrive = (
  current: Option.Option<Drive>,
  forRun: (runId: RunId) => Option.Option<Drive>,
): ((command: CellCommand) => Option.Option<Drive>) =>
  CellCommand.$match({
    OpenRun: () => current,
    StartRun: ({ runId }) => forRun(runId),
    RenderOutputs: ({ runId }) => forRun(runId),
    CloseRun: ({ runId }) => forRun(runId),
    PresentUntrackedError: () => current,
    SetDiagnostic: () => current,
  });

const cellRef = (notebookId: NotebookId, cellId: NotebookCellId): CellRef => ({
  notebookId,
  cellId,
});

/** The drive bound when the given run opened, if the binding still holds it. */
const boundDrive = (
  binding: Option.Option<DriveBinding>,
  runId: RunId,
): Option.Option<Drive> =>
  Option.filter(binding, (candidate) => candidate.runId === runId).pipe(
    Option.map((binding) => binding.value),
  );

const makeCellState = (
  editorSource: Option.Option<string> = Option.none(),
): CellExecutionState => ({
  run: makeCellRunState(),
  editorSource,
  pendingSources: [],
});

const getCell = (
  state: DocumentExecutionState,
  cellId: NotebookCellId,
): CellExecutionState =>
  Option.getOrElse(HashMap.get(state, cellId), () => makeCellState());

const setCell = (
  state: DocumentExecutionState,
  cellId: NotebookCellId,
  cell: CellExecutionState,
): DocumentExecutionState => HashMap.set(state, cellId, cell);

const makeDocumentExecutionState = (
  sources: ReadonlyArray<CellSource>,
): DocumentExecutionState => updateExecutionSources(HashMap.empty(), sources);

function updateExecutionSources(
  state: DocumentExecutionState,
  sources: ReadonlyArray<CellSource>,
): DocumentExecutionState {
  for (const { cellId, source } of sources) {
    state = setCell(state, cellId, {
      ...getCell(state, cellId),
      editorSource: Option.some(source),
    });
  }
  return state;
}

const registerSubmission = (
  state: DocumentExecutionState,
  token: symbol,
  sources: ReadonlyArray<CellSource>,
): DocumentExecutionState => {
  for (const { cellId, source } of sources) {
    const cell = getCell(state, cellId);
    state = setCell(state, cellId, {
      ...cell,
      pendingSources: [...cell.pendingSources, { token, source }],
    });
  }
  return state;
};

const rollbackSubmission = (
  state: DocumentExecutionState,
  token: symbol,
  cellIds: ReadonlyArray<NotebookCellId>,
): DocumentExecutionState => {
  for (const cellId of cellIds) {
    const cell = HashMap.get(state, cellId);
    if (Option.isNone(cell)) continue;
    state = setCell(state, cellId, {
      ...cell.value,
      pendingSources: cell.value.pendingSources.filter(
        (submitted) => submitted.token !== token,
      ),
    });
  }
  return state;
};

const clearPendingSources = (
  state: DocumentExecutionState,
): DocumentExecutionState => {
  for (const [cellId, cell] of state) {
    if (cell.pendingSources.length === 0) continue;
    state = setCell(state, cellId, { ...cell, pendingSources: [] });
  }
  return state;
};

const dequeueSubmittedSource = (
  cell: CellExecutionState,
): readonly [Option.Option<string>, CellExecutionState] => {
  const [submitted, ...pendingSources] = cell.pendingSources;
  return [
    Option.fromNullishOr(submitted).pipe(Option.map(({ source }) => source)),
    { ...cell, pendingSources },
  ];
};

const correlationError = (
  run: CellRunState,
  wire: CellOperationNotification,
): Option.Option<RunCorrelationError> => {
  const cellId = extractCellIdFromCellMessage(wire);
  const expectedRunId = activeRunId(run.phase);
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

const transitionFor = (
  cellId: NotebookCellId,
  current: CellRunState,
  commands: ReadonlyArray<CellCommand>,
): CellTransition => ({ cellId, current, commands });

const applyKernelOperation = (
  state: DocumentExecutionState,
  wire: CellOperationNotification,
): OperationTransition => {
  const cellId = extractCellIdFromCellMessage(wire);
  const previousCell = getCell(state, cellId);
  const nextRuntime = transitionCell(previousCell.run.state, wire);
  const parsed = parseOp(nextRuntime, wire);

  if (Option.isNone(parsed)) {
    const [, dequeued] =
      wire.status === "queued"
        ? dequeueSubmittedSource(previousCell)
        : [Option.none<string>(), previousCell];
    const current = acceptKernelState(dequeued.run, nextRuntime);
    return {
      state: setCell(state, cellId, { ...dequeued, run: current }),
      cells: [transitionFor(cellId, current, [])],
      error: Option.some(
        new RunCorrelationError({
          cellId,
          expectedRunId: activeRunId(previousCell.run.phase),
          receivedRunId: Option.none(),
          status: wire.status,
          reason: "untracked-queue",
        }),
      ),
    };
  }

  const op = parsed.value;
  let nextCell = previousCell;
  let source = Option.none<string>();
  if (Op.$is("Queue")(op)) {
    const [submittedSource, dequeued] = dequeueSubmittedSource(previousCell);
    nextCell = dequeued;
    source = submittedSource.pipe(
      Option.orElse(() => previousCell.editorSource),
    );
  }

  const result = step(previousCell.run, op, source);
  const mismatch = correlationError(previousCell.run, wire);
  if (Option.isSome(mismatch) && result.commands.length > 0) {
    const current = acceptKernelState(previousCell.run, nextRuntime);
    return {
      state: setCell(state, cellId, { ...previousCell, run: current }),
      cells: [transitionFor(cellId, current, [])],
      error: mismatch,
    };
  }

  if (
    wire.status === "idle" &&
    Option.isNone(activeRunId(previousCell.run.phase))
  ) {
    [, nextCell] = dequeueSubmittedSource(nextCell);
  }
  nextCell = { ...nextCell, run: result.entry };
  return {
    state: setCell(state, cellId, nextCell),
    cells: [transitionFor(cellId, result.entry, result.commands)],
    error: Option.none(),
  };
};

const releaseAll = (
  state: DocumentExecutionState,
  operation: Op,
  remove: boolean,
): DocumentTransition => {
  const cells: CellTransition[] = [];
  state = clearPendingSources(state);
  for (const [cellId, cell] of state) {
    const result = step(cell.run, operation);
    cells.push(transitionFor(cellId, result.entry, result.commands));
    state = remove
      ? HashMap.remove(state, cellId)
      : setCell(state, cellId, { ...cell, run: result.entry });
  }
  return { state, cells };
};

const interruptAll = (state: DocumentExecutionState): DocumentTransition =>
  releaseAll(state, Op.Interrupt(), false);

const invalidateAll = (state: DocumentExecutionState): DocumentTransition =>
  releaseAll(state, Op.Invalidate(), false);

const closeExecution = (state: DocumentExecutionState): DocumentTransition =>
  releaseAll(state, Op.Interrupt(), true);

const removeExecutionCell = (
  state: DocumentExecutionState,
  cellId: NotebookCellId,
): DocumentTransition => {
  const cell = HashMap.get(state, cellId);
  if (Option.isNone(cell)) return { state, cells: [] };
  const result = step(cell.value.run, Op.Interrupt());
  return {
    state: HashMap.remove(state, cellId),
    cells: [transitionFor(cellId, result.entry, result.commands)],
  };
};

const isCellStale = (
  state: DocumentExecutionState,
  cellId: NotebookCellId,
): boolean =>
  Option.exists(HashMap.get(state, cellId), (cell) =>
    AcceptedSource.$match(cell.run.acceptedSource, {
      Unknown: () => false,
      Invalidated: () => true,
      Accepted: ({ source }) =>
        Option.exists(cell.editorSource, (current) => current !== source),
    }),
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
        const initialSources = notebook.getCells().flatMap((cell) =>
          Option.match(cell.id, {
            onNone: () => [],
            onSome: (cellId) => [{ cellId, source: cell.document.getText() }],
          }),
        );
        let state = makeDocumentExecutionState(initialSources);
        const driveBindings = new Map<NotebookCellId, DriveBinding>();
        const staleRef = yield* SubscriptionRef.make(
          HashSet.empty<NotebookCellId>(),
        );
        const ordering = Semaphore.makeUnsafe(1);
        const scope = yield* Effect.scope;
        const presentationScope = yield* Scope.fork(scope);
        const presentation = yield* Queue.unbounded<Work, Cause.Done>();
        let closed = false;

        /** Publishes a changed stale-cell set locally and globally. */
        const publishStale = (next: HashSet.HashSet<NotebookCellId>) =>
          Effect.gen(function* () {
            const current = yield* SubscriptionRef.get(staleRef);
            if (Equal.equals(current, next)) return;
            yield* SubscriptionRef.set(staleRef, next);
            yield* SubscriptionRef.update(allStaleCells, (all) =>
              HashMap.set(all, notebookId, next),
            );
          });

        /** Returns whether a cell is invalidated or differs from its accepted source. */
        const isStale = (cellId: NotebookCellId): boolean =>
          isCellStale(state, cellId);

        /** Recomputes staleness for the given cells. */
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

        /** Records current sources and refreshes their staleness. */
        const updateSources = (sources: ReadonlyArray<CellSource>) =>
          ordering.withPermit(
            Effect.gen(function* () {
              if (closed) return;
              state = updateExecutionSources(state, sources);
              yield* refreshStale(sources.map(({ cellId }) => cellId));
            }),
          );

        /** Runs one presentation command and logs non-interruption failures. */
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

        /** Runs a batch while conflating pending output for each cell. */
        const driveBatch = (batch: ReadonlyArray<Work>) => {
          const newestOutput = new Map<NotebookCellId, number>();
          for (const [index, work] of batch.entries()) {
            if (isConflatableOutput(work.command)) {
              newestOutput.set(work.cell.cellId, index);
            }
          }

          return Effect.forEach(
            batch,
            (work, index) =>
              isConflatableOutput(work.command) &&
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

        /** Enqueues one command for ordered presentation. */
        const present = (work: Work) =>
          Queue.offer(presentation, work).pipe(
            Effect.flatMap((admitted) =>
              admitted
                ? Effect.void
                : Effect.die("Cell presentation is closed"),
            ),
          );

        /** Binds commands to the drive that owns each transitioned run. */
        const admitTransition = (
          transition: DocumentTransition,
          currentDrive: Option.Option<Drive>,
        ) =>
          Effect.gen(function* () {
            for (const result of transition.cells) {
              const previousBinding = Option.fromNullishOr(
                driveBindings.get(result.cellId),
              );
              const opened = new Set<RunId>();
              for (const command of result.commands) {
                if (CellCommand.$is("OpenRun")(command)) {
                  opened.add(command.runId);
                }
              }
              const driveForRun = (runId: RunId): Option.Option<Drive> =>
                boundDrive(previousBinding, runId).pipe(
                  Option.orElse(() =>
                    opened.has(runId) ? currentDrive : Option.none(),
                  ),
                );
              const nextBinding = activeRunId(result.current.phase).pipe(
                Option.flatMap((runId) =>
                  driveForRun(runId).pipe(
                    Option.map((value) => ({ runId, value })),
                  ),
                ),
              );
              if (Option.isSome(nextBinding)) {
                driveBindings.set(result.cellId, nextBinding.value);
              } else {
                driveBindings.delete(result.cellId);
              }

              const driveForCommand = selectCommandDrive(
                currentDrive,
                driveForRun,
              );
              for (const command of result.commands) {
                yield* present({
                  cell: cellRef(notebookId, result.cellId),
                  command,
                  drive: driveForCommand(command),
                });
              }
            }
          });

        const apply: NotebookExecutions["apply"] = (wire) =>
          ordering.withPermit(
            Effect.gen(function* () {
              if (closed) return;
              const cellId = extractCellIdFromCellMessage(wire);
              const result = applyKernelOperation(state, wire);
              state = result.state;
              yield* refreshStale([cellId]);
              yield* Option.match(result.error, {
                onNone: () =>
                  binding.getDrive.pipe(
                    Effect.flatMap((drive) => admitTransition(result, drive)),
                  ),
                onSome: Effect.fail,
              });
            }).pipe(
              Effect.annotateLogs({
                notebookId,
                cellId: extractCellIdFromCellMessage(wire),
              }),
            ),
          );

        /** Applies a bulk transition and releases matching presentation state. */
        const release = (result: DocumentTransition) =>
          Effect.gen(function* () {
            state = result.state;
            yield* admitTransition(result, Option.none());
            yield* refreshStale(result.cells.map(({ cellId }) => cellId));
          });

        const interrupt = ordering.withPermit(
          Effect.gen(function* () {
            if (closed) return;
            yield* release(interruptAll(state));
          }),
        );

        const invalidate = ordering.withPermit(
          Effect.gen(function* () {
            if (closed) return;
            yield* release(invalidateAll(state));
          }),
        );

        const remove = (cellId: NotebookCellId) =>
          ordering.withPermit(
            Effect.gen(function* () {
              if (closed) return;
              yield* release(removeExecutionCell(state, cellId));
            }),
          );

        const submit: NotebookExecutions["submit"] = (cells, send) => {
          const token = Symbol("cell submission");
          const register = ordering.withPermit(
            Effect.sync(() => {
              state = registerSubmission(state, token, cells);
            }),
          );
          const rollback = ordering.withPermit(
            Effect.sync(() => {
              state = rollbackSubmission(
                state,
                token,
                cells.map(({ cellId }) => cellId),
              );
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
              yield* release(closeExecution(state));
              yield* Queue.end(presentation);
              yield* Fiber.join(presentationWorker);
              driveBindings.clear();
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
