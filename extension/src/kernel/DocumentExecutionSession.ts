import {
  Cause,
  Data,
  Effect,
  Equal,
  Exit,
  Fiber,
  HashMap,
  HashSet,
  Option,
  Queue,
  Scope,
  Semaphore,
  Stream,
} from "effect";

import {
  extractCellIdFromCellMessage,
  type MarimoNotebookDocument,
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

export interface CellSource {
  readonly cellId: NotebookCellId;
  readonly source: string;
}

export interface CellStalenessChange {
  readonly cellId: NotebookCellId;
  readonly stale: boolean;
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

interface DocumentExecutionSessionOptions {
  readonly notebook: MarimoNotebookDocument;
  readonly getDrive: Effect.Effect<Option.Option<Drive>>;
  readonly onStaleChange: (
    changes: ReadonlyArray<CellStalenessChange>,
  ) => Effect.Effect<void>;
}

interface DriveBinding {
  readonly runId: RunId;
  readonly value: Drive;
}

interface SubmittedSource {
  readonly token: symbol;
  readonly source: string;
}

interface CellExecutionState {
  readonly run: CellRunState;
  readonly editorSource: Option.Option<string>;
  readonly pendingSources: ReadonlyArray<SubmittedSource>;
  readonly savedOutputStale: boolean;
}

interface DocumentExecutionState {
  readonly cells: HashMap.HashMap<NotebookCellId, CellExecutionState>;
  readonly removedCells: HashSet.HashSet<NotebookCellId>;
}

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
  savedOutputStale: false,
});

const getCell = (
  state: DocumentExecutionState,
  cellId: NotebookCellId,
): CellExecutionState =>
  Option.getOrElse(HashMap.get(state.cells, cellId), () => makeCellState());

const setCell = (
  state: DocumentExecutionState,
  cellId: NotebookCellId,
  cell: CellExecutionState,
): DocumentExecutionState => ({
  cells: HashMap.set(state.cells, cellId, cell),
  removedCells: state.removedCells,
});

const restoreCell = (
  state: DocumentExecutionState,
  cellId: NotebookCellId,
  cell: CellExecutionState,
): DocumentExecutionState => ({
  cells: HashMap.set(state.cells, cellId, cell),
  removedCells: HashSet.remove(state.removedCells, cellId),
});

const makeDocumentExecutionState = (
  sources: ReadonlyArray<CellSource>,
): DocumentExecutionState =>
  updateExecutionSources(
    { cells: HashMap.empty(), removedCells: HashSet.empty() },
    sources,
  );

function updateExecutionSources(
  state: DocumentExecutionState,
  sources: ReadonlyArray<CellSource>,
): DocumentExecutionState {
  for (const { cellId, source } of sources) {
    state = restoreCell(state, cellId, {
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

const confirmSubmission = (
  state: DocumentExecutionState,
  token: symbol,
  cellIds: ReadonlyArray<NotebookCellId>,
): DocumentExecutionState => {
  for (const cellId of cellIds) {
    const cell = HashMap.get(state.cells, cellId);
    if (
      Option.isSome(cell) &&
      cell.value.pendingSources.some((submitted) => submitted.token === token)
    ) {
      state = restoreCell(state, cellId, cell.value);
    }
  }
  return state;
};

const rollbackSubmission = (
  state: DocumentExecutionState,
  token: symbol,
  cellIds: ReadonlyArray<NotebookCellId>,
): DocumentExecutionState => {
  for (const cellId of cellIds) {
    const cell = HashMap.get(state.cells, cellId);
    if (Option.isNone(cell)) continue;
    const pendingSources = cell.value.pendingSources.filter(
      (submitted) => submitted.token !== token,
    );
    if (
      pendingSources.length === 0 &&
      HashSet.has(state.removedCells, cellId)
    ) {
      state = { ...state, cells: HashMap.remove(state.cells, cellId) };
      continue;
    }
    state = setCell(state, cellId, {
      ...cell.value,
      pendingSources,
    });
  }
  return state;
};

const clearPendingSources = (
  state: DocumentExecutionState,
): DocumentExecutionState => {
  for (const [cellId, cell] of state.cells) {
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
  // Any admitted kernel state supersedes display-only output from disk.
  const previousCell = {
    ...getCell(state, cellId),
    savedOutputStale: false,
  };
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
  for (const [cellId, cell] of state.cells) {
    const result = step(cell.run, operation);
    cells.push(transitionFor(cellId, result.entry, result.commands));
    state = remove
      ? { ...state, cells: HashMap.remove(state.cells, cellId) }
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
  const cell = HashMap.get(state.cells, cellId);
  const removed = {
    cells: HashMap.remove(state.cells, cellId),
    removedCells: HashSet.add(state.removedCells, cellId),
  };
  if (Option.isNone(cell)) return { state: removed, cells: [] };
  const result = step(cell.value.run, Op.Interrupt());
  return {
    state: removed,
    cells: [transitionFor(cellId, result.entry, result.commands)],
  };
};

const isCellStale = (
  state: DocumentExecutionState,
  cellId: NotebookCellId,
): boolean =>
  Option.exists(
    HashMap.get(state.cells, cellId),
    (cell) =>
      cell.savedOutputStale ||
      AcceptedSource.$match(cell.run.acceptedSource, {
        Unknown: () => false,
        Invalidated: () => true,
        Accepted: ({ source }) =>
          Option.exists(cell.editorSource, (current) => current !== source),
      }),
  );

/** Execution state and presentation for one exact notebook document session. */
export class DocumentExecutionSession {
  private state: DocumentExecutionState;
  private readonly driveBindings = new Map<NotebookCellId, DriveBinding>();
  private readonly ordering = Semaphore.makeUnsafe(1);
  private readonly options: DocumentExecutionSessionOptions;
  private readonly presentationScope: Scope.Closeable;
  private readonly presentation: Queue.Queue<Work, Cause.Done>;
  private presentationWorker!: Fiber.Fiber<void>;
  private closed = false;

  private constructor(
    options: DocumentExecutionSessionOptions,
    presentationScope: Scope.Closeable,
    presentation: Queue.Queue<Work, Cause.Done>,
  ) {
    this.options = options;
    this.presentationScope = presentationScope;
    this.presentation = presentation;
    const initialSources = options.notebook.getCells().flatMap((cell) =>
      Option.match(cell.id, {
        onNone: () => [],
        onSome: (cellId) => [{ cellId, source: cell.document.getText() }],
      }),
    );
    this.state = makeDocumentExecutionState(initialSources);
  }

  static readonly make = Effect.fn("DocumentExecutionSession.make")(function* (
    options: DocumentExecutionSessionOptions,
  ) {
    const presentationScope = yield* Scope.make();
    const presentation = yield* Queue.unbounded<Work, Cause.Done>();
    const session = new DocumentExecutionSession(
      options,
      presentationScope,
      presentation,
    );
    session.presentationWorker = yield* Stream.fromQueue(presentation).pipe(
      Stream.runForEachArray((batch) => session.driveBatch(batch)),
      Effect.forkIn(presentationScope),
    );
    return session;
  });

  /** Publishes changed staleness for only the affected cells. */
  private publishStale(cellIds: Iterable<NotebookCellId>) {
    const changes = [...new Set(cellIds)].map((cellId) => ({
      cellId,
      stale: isCellStale(this.state, cellId),
    }));
    return changes.length === 0
      ? Effect.void
      : this.options.onStaleChange(changes);
  }

  readonly updateSources = (sources: ReadonlyArray<CellSource>) =>
    this.ordering.withPermit(
      Effect.gen({ self: this }, function* () {
        if (this.closed) return;
        this.state = updateExecutionSources(this.state, sources);
        yield* this.publishStale(sources.map(({ cellId }) => cellId));
      }),
    );

  /** Runs one presentation command and logs non-interruption failures. */
  private drive({ cell, command, drive: target }: Work) {
    return Option.match(target, {
      onNone: () =>
        Effect.logDebug("Cell run has no presentation; skipping command").pipe(
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
                    ...("runId" in command ? { runId: command.runId } : {}),
                  }),
                ),
          ),
        ),
    });
  }

  /** Runs a batch while conflating pending output for each cell. */
  private driveBatch(batch: ReadonlyArray<Work>) {
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
          : this.drive(work),
      { discard: true },
    );
  }

  /** Enqueues one command for ordered presentation. */
  private present(work: Work) {
    return Queue.offer(this.presentation, work).pipe(
      Effect.flatMap((admitted) =>
        admitted ? Effect.void : Effect.die("Cell presentation is closed"),
      ),
    );
  }

  /** Binds commands to the drive that owns each transitioned run. */
  private admitTransition(
    transition: DocumentTransition,
    currentDrive: Option.Option<Drive>,
  ) {
    return Effect.gen({ self: this }, function* () {
      for (const result of transition.cells) {
        const previousBinding = Option.fromNullishOr(
          this.driveBindings.get(result.cellId),
        );
        const opened = new Set<RunId>();
        for (const command of result.commands) {
          if (CellCommand.$is("OpenRun")(command)) opened.add(command.runId);
        }
        const driveForRun = (runId: RunId): Option.Option<Drive> =>
          boundDrive(previousBinding, runId).pipe(
            Option.orElse(() =>
              opened.has(runId) ? currentDrive : Option.none(),
            ),
          );
        const nextBinding = activeRunId(result.current.phase).pipe(
          Option.flatMap((runId) =>
            driveForRun(runId).pipe(Option.map((value) => ({ runId, value }))),
          ),
        );
        if (Option.isSome(nextBinding)) {
          this.driveBindings.set(result.cellId, nextBinding.value);
        } else {
          this.driveBindings.delete(result.cellId);
        }

        const driveForCommand = selectCommandDrive(currentDrive, driveForRun);
        for (const command of result.commands) {
          yield* this.present({
            cell: cellRef(this.options.notebook.id, result.cellId),
            command,
            drive: driveForCommand(command),
          });
        }
      }
    });
  }

  readonly apply = (wire: CellOperationNotification) =>
    this.ordering.withPermit(
      Effect.gen({ self: this }, function* () {
        if (this.closed) return;
        const cellId = extractCellIdFromCellMessage(wire);
        if (HashSet.has(this.state.removedCells, cellId)) return;
        const result = applyKernelOperation(this.state, wire);
        this.state = result.state;
        yield* this.publishStale([cellId]);
        yield* Option.match(result.error, {
          onNone: () =>
            this.options.getDrive.pipe(
              Effect.flatMap((drive) => this.admitTransition(result, drive)),
            ),
          onSome: Effect.fail,
        });
      }).pipe(Effect.annotateLogs({ notebookId: this.options.notebook.id })),
    );

  private release(result: DocumentTransition) {
    return Effect.gen({ self: this }, function* () {
      this.state = result.state;
      yield* this.admitTransition(result, Option.none());
      yield* this.publishStale(result.cells.map(({ cellId }) => cellId));
    });
  }

  get interrupt() {
    return this.ordering.withPermit(
      Effect.gen({ self: this }, function* () {
        if (this.closed) return;
        yield* this.release(interruptAll(this.state));
      }),
    );
  }

  get invalidate() {
    return this.ordering.withPermit(
      Effect.gen({ self: this }, function* () {
        if (this.closed) return;
        yield* this.release(invalidateAll(this.state));
      }),
    );
  }

  readonly remove = (cellId: NotebookCellId) =>
    this.ordering.withPermit(
      Effect.gen({ self: this }, function* () {
        if (this.closed) return;
        yield* this.release(removeExecutionCell(this.state, cellId));
      }),
    );

  readonly markSavedOutputsStale = (cellIds: ReadonlyArray<NotebookCellId>) =>
    this.ordering.withPermit(
      Effect.gen({ self: this }, function* () {
        if (this.closed) return;
        const marked: NotebookCellId[] = [];
        for (const cellId of cellIds) {
          if (HashSet.has(this.state.removedCells, cellId)) continue;
          const cell = HashMap.get(this.state.cells, cellId);
          if (Option.isNone(cell)) continue;
          this.state = setCell(this.state, cellId, {
            ...cell.value,
            savedOutputStale: true,
          });
          marked.push(cellId);
        }
        yield* this.publishStale(marked);
      }),
    );

  readonly submit = <A, E, R>(
    cells: ReadonlyArray<CellSource>,
    send: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    const token = Symbol("cell submission");
    const register = this.ordering.withPermit(
      Effect.sync(() => {
        this.state = registerSubmission(this.state, token, cells);
      }),
    );
    const rollback = this.ordering.withPermit(
      Effect.sync(() => {
        this.state = rollbackSubmission(
          this.state,
          token,
          cells.map(({ cellId }) => cellId),
        );
      }),
    );
    const confirm = this.ordering.withPermit(
      Effect.sync(() => {
        this.state = confirmSubmission(
          this.state,
          token,
          cells.map(({ cellId }) => cellId),
        );
      }),
    );
    return register.pipe(
      Effect.andThen(send),
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? confirm : rollback)),
    );
  };

  get close() {
    return Effect.uninterruptible(
      this.ordering.withPermit(
        Effect.gen({ self: this }, function* () {
          if (this.closed) return;
          this.closed = true;
          yield* this.release(closeExecution(this.state));
          yield* Queue.end(this.presentation);
          this.driveBindings.clear();
        }),
      ),
    );
  }

  get drained() {
    return Fiber.join(this.presentationWorker).pipe(
      Effect.ensuring(Scope.close(this.presentationScope, Exit.void)),
    );
  }
}
