import {
  Cause,
  Context,
  Data,
  Effect,
  HashMap,
  Layer,
  Option,
  Ref,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";

import type {
  NotebookCellId,
  NotebookId,
} from "../schemas/MarimoNotebookDocument.ts";
import type { CellOperationNotification } from "../types.ts";
import {
  Action,
  CellRunId,
  type CellRunState,
  makeCellRunState,
  Op,
  parseOp,
  step,
  transitionCell,
} from "./CellRunReducer.ts";

/** Stable identity of one cell whose runs are tracked. */
export interface CellRunRef {
  readonly notebookId: NotebookId;
  readonly cellId: NotebookCellId;
}

/** A cell snapshot used to ask whether its source is stale. */
export interface CellRunSnapshot extends CellRunRef {
  readonly source: string;
}

export type CellRunPresentationAction = Exclude<
  Action,
  { readonly _tag: "RecordExecution" | "InvalidateCell" }
>;

/**
 * Narrow Interface implemented by a platform Adapter.
 *
 * The Adapter owns any live platform resource returned when a run is created;
 * callers and the Cell Runs Module only submit domain actions.
 */
export interface CellRunPresentation {
  readonly apply: (
    cell: CellRunRef,
    action: CellRunPresentationAction,
  ) => Effect.Effect<void>;
}

/** Facts accepted by the Cell Runs Module. */
export type CellRunInput = Data.TaggedEnum<{
  Operations: {
    readonly notebookId: NotebookId;
    readonly operations: ReadonlyArray<CellOperationNotification>;
    readonly sourceByCell: ReadonlyMap<NotebookCellId, string>;
    readonly presentation: CellRunPresentation;
  };
  Interrupted: { readonly notebookId: NotebookId };
  CellsRemoved: {
    readonly notebookId: NotebookId;
    readonly cellIds: ReadonlyArray<NotebookCellId>;
  };
  Invalidated: { readonly notebookId: NotebookId };
}>;
export const CellRunInput = Data.taggedEnum<CellRunInput>();

type CellRunOperationsInput = Extract<
  CellRunInput,
  { readonly _tag: "Operations" }
>;

type AcceptedSource = Data.TaggedEnum<{
  Unknown: {};
  Invalidated: {};
  Accepted: { readonly source: string };
}>;
const AcceptedSource = Data.taggedEnum<AcceptedSource>();

interface CellRunRecord {
  readonly state: CellRunState;
  readonly acceptedSource: AcceptedSource;
  readonly presentation: Option.Option<{
    readonly runId: CellRunId;
    readonly adapter: CellRunPresentation;
  }>;
}

interface NotebookRunEntry {
  readonly records: Ref.Ref<HashMap.HashMap<NotebookCellId, CellRunRecord>>;
  readonly serial: Semaphore.Semaphore;
}

type RunRelease = Data.TaggedEnum<{
  RunsInterrupted: {};
  CellsRemoved: { readonly cellIds: ReadonlySet<NotebookCellId> };
  NotebookInvalidated: {};
  ModuleFinalized: {};
}>;
const RunRelease = Data.taggedEnum<RunRelease>();

interface PresentationWork {
  readonly cell: CellRunRef;
  readonly action: CellRunPresentationAction;
  readonly presentation: Option.Option<CellRunPresentation>;
}

const cellRunRef = (
  notebookId: NotebookId,
  cellId: NotebookCellId,
): CellRunRef => ({ notebookId, cellId });

const isPresentationAction = (
  action: Action,
): action is CellRunPresentationAction =>
  action._tag !== "RecordExecution" && action._tag !== "InvalidateCell";

/**
 * Owns cell-run state, accepted source, ordering, interruption, and cleanup.
 * Platform resources are private to the supplied presentation Adapter.
 */
export class CellRuns extends Context.Service<CellRuns>()("CellRuns", {
  make: Effect.gen(function* () {
    // Entries are stable ordering lanes. Invalidation clears their records but
    // retains the lane so a reopened notebook queues behind its cleanup.
    const notebooks = new Map<NotebookId, NotebookRunEntry>();
    // A revision, rather than a second state registry, gives subscribers an
    // atomic initial event plus every later staleness change.
    const revision = yield* SubscriptionRef.make(0);

    const makeEntry = (): NotebookRunEntry => ({
      records: Ref.makeUnsafe(HashMap.empty<NotebookCellId, CellRunRecord>()),
      serial: Semaphore.makeUnsafe(1),
    });

    const entryFor = (notebookId: NotebookId) => {
      const existing = notebooks.get(notebookId);
      if (existing !== undefined) return existing;
      const entry = makeEntry();
      notebooks.set(notebookId, entry);
      return entry;
    };

    const emptyRecord = (cellId: NotebookCellId): CellRunRecord => ({
      state: makeCellRunState(cellId),
      acceptedSource: AcceptedSource.Unknown(),
      presentation: Option.none(),
    });

    const createdRunIds = (actions: ReadonlyArray<Action>) => {
      const ids = new Set<CellRunId>();
      for (const action of actions) {
        if (action._tag === "CreateExecution") ids.add(action.runId);
      }
      return ids;
    };
    const noCreatedRuns = new Set<CellRunId>();

    const presentationFor = (
      action: Action,
      record: CellRunRecord,
      current: Option.Option<CellRunPresentation>,
      created: ReadonlySet<CellRunId>,
    ): Option.Option<CellRunPresentation> => {
      const forRun = (runId: CellRunId) =>
        Option.filter(
          record.presentation,
          (binding) => binding.runId === runId,
        ).pipe(
          Option.map((binding) => binding.adapter),
          Option.orElse(() => (created.has(runId) ? current : Option.none())),
        );

      return Action.$match(action, {
        CreateExecution: () => current,
        StartExecution: ({ runId }) => forRun(runId),
        EmitOutputs: ({ runId }) => forRun(runId),
        FinalizeOutputs: ({ runId }) => forRun(runId),
        EndExecution: ({ runId }) => forRun(runId),
        ApplyRuntimeError: () => current,
        ClearRuntimeError: () => current,
        RecordExecution: () => Option.none(),
        InvalidateCell: () => Option.none(),
      });
    };

    const presentationAfter = (
      state: CellRunState,
      record: CellRunRecord,
      current: CellRunPresentation,
      created: ReadonlySet<CellRunId>,
    ): CellRunRecord["presentation"] => {
      if (state.phase._tag !== "Queued" && state.phase._tag !== "Running") {
        return Option.none();
      }
      const runId = state.phase.runId;
      if (created.has(runId)) {
        return Option.some({ runId, adapter: current });
      }
      return Option.filter(
        record.presentation,
        (binding) => binding.runId === runId,
      );
    };

    const acceptedSourceAfter = (
      record: CellRunRecord,
      actions: ReadonlyArray<Action>,
      source: string | undefined,
    ) => {
      let acceptedSource = record.acceptedSource;
      let touched = false;
      let missingSource = false;

      for (const action of actions) {
        Action.$match(action, {
          RecordExecution: () => {
            if (source === undefined) {
              missingSource = true;
              return;
            }
            acceptedSource = AcceptedSource.Accepted({ source });
            touched = true;
          },
          InvalidateCell: () => {
            acceptedSource = AcceptedSource.Invalidated();
            touched = true;
          },
          CreateExecution: () => {},
          StartExecution: () => {},
          EmitOutputs: () => {},
          FinalizeOutputs: () => {},
          EndExecution: () => {},
          ApplyRuntimeError: () => {},
          ClearRuntimeError: () => {},
        });
      }

      return { acceptedSource, touched, missingSource } as const;
    };

    const applyPresentation = ({
      action,
      cell,
      presentation,
    }: PresentationWork) =>
      Option.match(presentation, {
        onNone: () =>
          Effect.logWarning(
            "Cell run has no presentation Adapter; skipping action",
          ).pipe(
            Effect.annotateLogs({
              ...cell,
              action: action._tag,
              ...("runId" in action ? { runId: action.runId } : {}),
            }),
          ),
        onSome: (adapter) =>
          adapter.apply(cell, action).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("Failed to present cell run action").pipe(
                    Effect.annotateLogs({
                      cause,
                      ...cell,
                      action: action._tag,
                      ...("runId" in action ? { runId: action.runId } : {}),
                    }),
                  ),
            ),
          ),
      });

    const acceptOperations = (
      entry: NotebookRunEntry,
      input: CellRunOperationsInput,
    ) =>
      entry.serial.withPermit(
        Effect.gen(function* () {
          let records = yield* Ref.get(entry.records);

          // Every operation advances state. Only presentation writes coalesce:
          // the newest renderable operation for each cell owns the output write.
          // A trailing state-only operation therefore cannot suppress output.
          const renderIndex = new Map<NotebookCellId, number>();
          for (const [index, operation] of input.operations.entries()) {
            if (
              operation.status === "idle" ||
              operation.output != null ||
              operation.console != null
            ) {
              renderIndex.set(operation.cell_id, index);
            }
          }

          for (const [index, message] of input.operations.entries()) {
            const cell = cellRunRef(input.notebookId, message.cell_id);
            const record = Option.getOrElse(
              HashMap.get(records, cell.cellId),
              () => emptyRecord(cell.cellId),
            );
            const next = transitionCell(record.state.state, message);
            const op = parseOp(next, message, CellRunId(crypto.randomUUID()));

            if (Option.isNone(op)) {
              records = HashMap.set(records, cell.cellId, {
                ...record,
                state: { ...record.state, state: next },
              });
              yield* Ref.set(entry.records, records);
              yield* Effect.logWarning(
                "Queued cell-op missing run_id; cannot track execution",
              ).pipe(
                Effect.annotateLogs({
                  ...cell,
                  status: message.status,
                }),
              );
              continue;
            }

            const result = step(record.state, op.value);
            const created = createdRunIds(result.actions);
            const source = input.sourceByCell.get(cell.cellId);
            const accepted = acceptedSourceAfter(
              record,
              result.actions,
              source,
            );
            records = HashMap.set(records, cell.cellId, {
              state: result.entry,
              acceptedSource: accepted.acceptedSource,
              presentation: presentationAfter(
                result.entry,
                record,
                input.presentation,
                created,
              ),
            });

            // Kernel facts become observable before their platform projection.
            yield* Ref.set(entry.records, records);
            if (accepted.touched) {
              yield* SubscriptionRef.update(revision, (value) => value + 1);
            }
            if (accepted.missingSource) {
              yield* Effect.logWarning(
                "Cell source unavailable; accepted source was not recorded",
              ).pipe(Effect.annotateLogs({ ...cell }));
            }

            for (const action of result.actions) {
              if (!isPresentationAction(action)) continue;
              if (
                renderIndex.get(cell.cellId) !== index &&
                (action._tag === "EmitOutputs" ||
                  action._tag === "FinalizeOutputs")
              ) {
                continue;
              }
              yield* applyPresentation({
                cell,
                action,
                presentation: presentationFor(
                  action,
                  record,
                  Option.some(input.presentation),
                  created,
                ),
              });
            }
          }
        }),
      );

    const releaseRuns = (
      notebookId: NotebookId,
      entry: NotebookRunEntry,
      release: RunRelease,
    ) =>
      entry.serial.withPermit(
        Effect.gen(function* () {
          const behavior = RunRelease.$match(release, {
            RunsInterrupted: () => ({
              target: (_cellId: NotebookCellId) => true,
              remove: false,
              notify: false,
            }),
            CellsRemoved: ({ cellIds }) => ({
              target: (cellId: NotebookCellId) => cellIds.has(cellId),
              remove: true,
              notify: true,
            }),
            NotebookInvalidated: () => ({
              target: (_cellId: NotebookCellId) => true,
              remove: true,
              notify: true,
            }),
            ModuleFinalized: () => ({
              target: (_cellId: NotebookCellId) => true,
              remove: true,
              notify: false,
            }),
          });

          let records = yield* Ref.get(entry.records);
          const work: PresentationWork[] = [];
          let changed = false;

          for (const [cellId, record] of records) {
            if (!behavior.target(cellId)) continue;
            changed = true;
            const cell = cellRunRef(notebookId, cellId);
            const result = step(record.state, Op.Interrupt());
            const current = Option.map(
              record.presentation,
              (binding) => binding.adapter,
            );
            for (const action of result.actions) {
              if (!isPresentationAction(action)) continue;
              work.push({
                cell,
                action,
                presentation: presentationFor(
                  action,
                  record,
                  current,
                  noCreatedRuns,
                ),
              });
            }
            records = behavior.remove
              ? HashMap.remove(records, cellId)
              : HashMap.set(records, cellId, {
                  ...record,
                  state: result.entry,
                  presentation: Option.none(),
                });
          }

          yield* Ref.set(entry.records, records);
          if (changed && behavior.notify) {
            yield* SubscriptionRef.update(revision, (value) => value + 1);
          }
          yield* Effect.forEach(work, applyPresentation, { discard: true });
        }),
      );

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        Array.from(notebooks),
        ([notebookId, entry]) =>
          releaseRuns(notebookId, entry, RunRelease.ModuleFinalized()),
        { discard: true },
      ),
    );

    const withExistingEntry = (
      notebookId: NotebookId,
      use: (entry: NotebookRunEntry) => Effect.Effect<void>,
    ) => {
      const entry = notebooks.get(notebookId);
      return entry === undefined ? Effect.void : use(entry);
    };

    return {
      isStale: (cell: CellRunSnapshot) =>
        Effect.suspend(() => {
          const entry = notebooks.get(cell.notebookId);
          if (entry === undefined) return Effect.succeed(false);
          return Ref.get(entry.records).pipe(
            Effect.map((records) =>
              Option.match(HashMap.get(records, cell.cellId), {
                onNone: () => false,
                onSome: (record) =>
                  AcceptedSource.$match(record.acceptedSource, {
                    Unknown: () => false,
                    Invalidated: () => true,
                    Accepted: ({ source }) => source !== cell.source,
                  }),
              }),
            ),
          );
        }),
      get changes(): Stream.Stream<void> {
        return Stream.map(SubscriptionRef.changes(revision), () => undefined);
      },
      accept: (input: CellRunInput) =>
        Effect.suspend(() =>
          CellRunInput.$match(input, {
            Operations: (operations) =>
              acceptOperations(entryFor(operations.notebookId), operations),
            Interrupted: ({ notebookId }) =>
              withExistingEntry(notebookId, (entry) =>
                releaseRuns(notebookId, entry, RunRelease.RunsInterrupted()),
              ),
            CellsRemoved: ({ notebookId, cellIds }) =>
              withExistingEntry(notebookId, (entry) =>
                releaseRuns(
                  notebookId,
                  entry,
                  RunRelease.CellsRemoved({ cellIds: new Set(cellIds) }),
                ),
              ),
            Invalidated: ({ notebookId }) =>
              withExistingEntry(notebookId, (entry) =>
                releaseRuns(
                  notebookId,
                  entry,
                  RunRelease.NotebookInvalidated(),
                ),
              ),
          }),
        ),
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
