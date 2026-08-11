import {
  Cause,
  Context,
  Data,
  Effect,
  Equal,
  Exit,
  Layer,
  MutableHashMap,
  Option,
  Semaphore,
  Stream,
  SubscriptionRef,
  Array as EffectArray,
} from "effect";

import type {
  NotebookCellId,
  NotebookId,
} from "../schemas/MarimoNotebookDocument.ts";
import type { CellOperationNotification } from "../types.ts";
import {
  AcceptedSource,
  CellCommand,
  type CellRunState,
  makeCellRunState,
  Op,
  parseOp,
  RunId,
  step,
  transitionCell,
} from "./CellRunReducer.ts";

/** Stable identity of one cell whose commands can be driven. */
export interface CellRef {
  readonly notebookId: NotebookId;
  readonly cellId: NotebookCellId;
}

/** A cell snapshot used to ask whether its accepted source is stale. */
export interface CellSnapshot extends CellRef {
  readonly source: string;
}

/** Effectful capability supplied by a host adapter. */
export type Drive = (
  cell: CellRef,
  command: CellCommand,
) => Effect.Effect<void>;

/** Facts accepted by the cell execution module. */
export type CellInput = Data.TaggedEnum<{
  Operation: {
    readonly notebookId: NotebookId;
    readonly operation: CellOperationNotification;
    readonly source?: string;
    readonly drive: Drive;
    readonly renderOutput?: boolean;
  };
  Interrupted: { readonly notebookId: NotebookId };
  CellsRemoved: {
    readonly notebookId: NotebookId;
    readonly cellIds: ReadonlyArray<NotebookCellId>;
  };
  Invalidated: { readonly notebookId: NotebookId };
}>;
export const CellInput = Data.taggedEnum<CellInput>();

type OperationInput = Extract<CellInput, { readonly _tag: "Operation" }>;

interface DriveBinding {
  readonly runId: RunId;
  readonly value: Drive;
}

/** Everything owned for one cell. */
interface CellRecord {
  readonly run: CellRunState;
  readonly drive: Option.Option<DriveBinding>;
}

interface SubmittedSource {
  readonly token: symbol;
  readonly source: string;
}

interface NotebookEntry {
  readonly records: MutableHashMap.MutableHashMap<NotebookCellId, CellRecord>;
  readonly submittedSources: MutableHashMap.MutableHashMap<
    NotebookCellId,
    Array<SubmittedSource>
  >;
  readonly serial: Semaphore.Semaphore;
}

type Release = Data.TaggedEnum<{
  Interrupted: {};
  CellsRemoved: { readonly cellIds: ReadonlySet<NotebookCellId> };
  Invalidated: {};
  Finalized: {};
}>;
const Release = Data.taggedEnum<Release>();

interface Work {
  readonly cell: CellRef;
  readonly command: CellCommand;
  readonly drive: Option.Option<Drive>;
}

const cellRef = (notebookId: NotebookId, cellId: NotebookCellId): CellRef => ({
  notebookId,
  cellId,
});

const openedRunIds = (commands: ReadonlyArray<CellCommand>) => {
  const ids = new Set<RunId>();
  for (const command of commands) {
    if (command._tag === "OpenRun") ids.add(command.runId);
  }
  return ids;
};

const noOpenedRuns = new Set<RunId>();

const resolveDriveBinding = (
  runId: RunId,
  record: CellRecord,
  current: Option.Option<Drive>,
  opened: ReadonlySet<RunId>,
): Option.Option<DriveBinding> =>
  Option.filter(record.drive, (binding) => binding.runId === runId).pipe(
    Option.orElse(() =>
      opened.has(runId)
        ? Option.map(current, (value) => ({ runId, value }))
        : Option.none(),
    ),
  );

const driveFor = (
  command: CellCommand,
  record: CellRecord,
  current: Option.Option<Drive>,
  opened: ReadonlySet<RunId>,
): Option.Option<Drive> => {
  const forRun = (runId: RunId) =>
    resolveDriveBinding(runId, record, current, opened).pipe(
      Option.map((binding) => binding.value),
    );

  return CellCommand.$match(command, {
    OpenRun: () => current,
    StartRun: ({ runId }) => forRun(runId),
    RenderOutputs: ({ runId }) => forRun(runId),
    CloseRun: ({ runId }) => forRun(runId),
    SetDiagnostic: () => current,
  });
};

const driveAfter = (
  run: CellRunState,
  record: CellRecord,
  current: Option.Option<Drive>,
  opened: ReadonlySet<RunId>,
): Option.Option<DriveBinding> => {
  if (run.phase._tag !== "Queued" && run.phase._tag !== "Running") {
    return Option.none();
  }
  const runId = run.phase.runId;
  return resolveDriveBinding(runId, record, current, opened);
};

/**
 * Owns cell records and turns kernel operations into ordered host commands.
 * Each notebook has one ordering lane; host resources stay behind {@link Drive}.
 */
export class CellExecutions extends Context.Service<CellExecutions>()(
  "CellExecutions",
  {
    make: Effect.gen(function* () {
      const notebooks = new Map<NotebookId, NotebookEntry>();
      const revision = yield* SubscriptionRef.make(0);

      const makeEntry = (): NotebookEntry => ({
        records: MutableHashMap.empty(),
        submittedSources: MutableHashMap.empty(),
        serial: Semaphore.makeUnsafe(1),
      });

      const entryFor = (notebookId: NotebookId) => {
        const existing = notebooks.get(notebookId);
        if (existing !== undefined) return existing;
        const entry = makeEntry();
        notebooks.set(notebookId, entry);
        return entry;
      };

      const emptyRecord = (cellId: NotebookCellId): CellRecord => ({
        run: makeCellRunState(cellId),
        drive: Option.none(),
      });

      const takeSubmittedSource = (
        entry: NotebookEntry,
        cellId: NotebookCellId,
      ) => {
        const pending = MutableHashMap.get(entry.submittedSources, cellId);
        if (Option.isNone(pending) || pending.value.length === 0) {
          return undefined;
        }
        const [submitted, ...remaining] = pending.value;
        if (remaining.length === 0) {
          MutableHashMap.remove(entry.submittedSources, cellId);
        } else {
          MutableHashMap.set(entry.submittedSources, cellId, remaining);
        }
        return submitted?.source;
      };

      const drive = ({ cell, command, drive }: Work) =>
        Option.match(drive, {
          onNone: () =>
            Effect.logWarning("Cell run has no Drive; skipping command").pipe(
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

      const acceptOperation = (entry: NotebookEntry, input: OperationInput) =>
        entry.serial.withPermit(
          Effect.gen(function* () {
            const message = input.operation;
            const cell = cellRef(input.notebookId, message.cell_id);
            const record = Option.getOrElse(
              MutableHashMap.get(entry.records, cell.cellId),
              () => emptyRecord(cell.cellId),
            );
            const activeRunId =
              record.run.phase._tag === "Queued" ||
              record.run.phase._tag === "Running"
                ? record.run.phase.runId
                : undefined;
            const receivedRunId =
              typeof message.run_id === "string" && message.run_id.length > 0
                ? message.run_id
                : undefined;
            if (
              message.status !== "queued" &&
              receivedRunId !== undefined &&
              receivedRunId !== activeRunId
            ) {
              yield* Effect.logWarning(
                "Cell operation targets a superseded run; skipping",
              ).pipe(
                Effect.annotateLogs({
                  expectedRunId: activeRunId,
                  receivedRunId,
                  status: message.status,
                }),
              );
              return;
            }

            const next = transitionCell(record.run.state, message);
            const op = parseOp(next, message, RunId(crypto.randomUUID()));

            if (Option.isNone(op)) {
              takeSubmittedSource(entry, cell.cellId);
              MutableHashMap.set(entry.records, cell.cellId, {
                ...record,
                run: { ...record.run, state: next },
              });
              yield* Effect.logWarning(
                "Queued cell-op missing run_id; cannot track execution",
              ).pipe(Effect.annotateLogs({ ...cell, status: message.status }));
              return;
            }

            if (message.status === "idle" && activeRunId === undefined) {
              takeSubmittedSource(entry, cell.cellId);
            }

            const source =
              op.value._tag === "Queue"
                ? (takeSubmittedSource(entry, cell.cellId) ?? input.source)
                : undefined;
            const result = step(record.run, op.value, source);
            const opened = openedRunIds(result.commands);
            MutableHashMap.set(entry.records, cell.cellId, {
              run: result.entry,
              drive: driveAfter(
                result.entry,
                record,
                Option.some(input.drive),
                opened,
              ),
            });
            if (
              !Equal.equals(
                result.entry.acceptedSource,
                record.run.acceptedSource,
              )
            ) {
              yield* SubscriptionRef.update(revision, (value) => value + 1);
            }

            for (const command of result.commands) {
              if (
                input.renderOutput === false &&
                command._tag === "RenderOutputs"
              ) {
                continue;
              }
              yield* drive({
                cell,
                command,
                drive: driveFor(
                  command,
                  record,
                  Option.some(input.drive),
                  opened,
                ),
              });
            }
          }),
        );

      const release = (
        notebookId: NotebookId,
        entry: NotebookEntry,
        reason: Release,
      ) =>
        entry.serial.withPermit(
          Effect.gen(function* () {
            const behavior = Release.$match(reason, {
              Interrupted: () => ({
                target: (_cellId: NotebookCellId) => true,
                remove: false,
                notify: false,
              }),
              CellsRemoved: ({ cellIds }) => ({
                target: (cellId: NotebookCellId) => cellIds.has(cellId),
                remove: true,
                notify: true,
              }),
              Invalidated: () => ({
                target: (_cellId: NotebookCellId) => true,
                remove: true,
                notify: true,
              }),
              Finalized: () => ({
                target: (_cellId: NotebookCellId) => true,
                remove: true,
                notify: false,
              }),
            });
            const work: Work[] = [];
            let changed = false;

            for (const [cellId, record] of EffectArray.fromIterable(
              entry.records,
            )) {
              if (!behavior.target(cellId)) continue;
              changed = true;
              const cell = cellRef(notebookId, cellId);
              const result = step(record.run, Op.Interrupt());
              for (const command of result.commands) {
                work.push({
                  cell,
                  command,
                  drive: driveFor(command, record, Option.none(), noOpenedRuns),
                });
              }

              if (behavior.remove) {
                MutableHashMap.remove(entry.records, cellId);
              } else {
                MutableHashMap.set(entry.records, cellId, {
                  run: result.entry,
                  drive: Option.none(),
                });
              }
            }

            for (const [cellId] of EffectArray.fromIterable(
              entry.submittedSources,
            )) {
              if (behavior.target(cellId)) {
                MutableHashMap.remove(entry.submittedSources, cellId);
              }
            }

            if (changed && behavior.notify) {
              yield* SubscriptionRef.update(revision, (value) => value + 1);
            }
            yield* Effect.forEach(work, drive, { discard: true });
          }),
        );

      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          Array.from(notebooks),
          ([notebookId, entry]) =>
            release(notebookId, entry, Release.Finalized()),
          { discard: true },
        ),
      );

      const withEntry = (
        notebookId: NotebookId,
        use: (entry: NotebookEntry) => Effect.Effect<void>,
      ) => {
        const entry = notebooks.get(notebookId);
        return entry === undefined ? Effect.void : use(entry);
      };

      return {
        isStale: (cell: CellSnapshot) =>
          Effect.sync(() => {
            const entry = notebooks.get(cell.notebookId);
            if (entry === undefined) return false;
            return Option.match(
              MutableHashMap.get(entry.records, cell.cellId),
              {
                onNone: () => false,
                onSome: ({ run }) =>
                  AcceptedSource.$match(run.acceptedSource, {
                    Unknown: () => false,
                    Invalidated: () => true,
                    Accepted: ({ source }) => source !== cell.source,
                  }),
              },
            );
          }),
        get changes(): Stream.Stream<void> {
          return Stream.map(SubscriptionRef.changes(revision), () => undefined);
        },
        submit: <A, E, R>(
          notebookId: NotebookId,
          cells: ReadonlyArray<{
            readonly cellId: NotebookCellId;
            readonly source: string;
          }>,
          send: Effect.Effect<A, E, R>,
        ) => {
          const entry = entryFor(notebookId);
          const token = Symbol("cell submission");
          const register = entry.serial.withPermit(
            Effect.sync(() => {
              for (const { cellId, source } of cells) {
                const pending = Option.getOrElse(
                  MutableHashMap.get(entry.submittedSources, cellId),
                  () => [],
                );
                MutableHashMap.set(entry.submittedSources, cellId, [
                  ...pending,
                  { token, source },
                ]);
              }
            }),
          );
          const rollback = entry.serial.withPermit(
            Effect.sync(() => {
              for (const { cellId } of cells) {
                const pending = MutableHashMap.get(
                  entry.submittedSources,
                  cellId,
                );
                if (Option.isNone(pending)) continue;
                const remaining = pending.value.filter(
                  (submitted) => submitted.token !== token,
                );
                if (remaining.length === 0) {
                  MutableHashMap.remove(entry.submittedSources, cellId);
                } else {
                  MutableHashMap.set(entry.submittedSources, cellId, remaining);
                }
              }
            }),
          );
          return register.pipe(
            Effect.andThen(send),
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : rollback,
            ),
          );
        },
        accept: (input: CellInput) =>
          Effect.suspend(() =>
            CellInput.$match(input, {
              Operation: (operation) =>
                acceptOperation(entryFor(operation.notebookId), operation),
              Interrupted: ({ notebookId }) =>
                withEntry(notebookId, (entry) =>
                  release(notebookId, entry, Release.Interrupted()),
                ),
              CellsRemoved: ({ notebookId, cellIds }) =>
                withEntry(notebookId, (entry) =>
                  release(
                    notebookId,
                    entry,
                    Release.CellsRemoved({ cellIds: new Set(cellIds) }),
                  ),
                ),
              Invalidated: ({ notebookId }) =>
                withEntry(notebookId, (entry) =>
                  release(notebookId, entry, Release.Invalidated()),
                ),
            }),
          ),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
