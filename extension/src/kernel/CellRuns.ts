import {
  Context,
  Data,
  Effect,
  HashMap,
  Layer,
  MutableHashMap,
  Option,
  Stream,
  SubscriptionRef,
  Array as EffectArray,
} from "effect";
import { constVoid } from "effect/Function";

import type {
  NotebookCellId,
  NotebookId,
} from "../schemas/MarimoNotebookDocument.ts";
import type { CellOperationNotification } from "../types.ts";
import {
  type Action,
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
}>;
export const CellRunInput = Data.taggedEnum<CellRunInput>();

type CellRunOperationsInput = Extract<
  CellRunInput,
  { readonly _tag: "Operations" }
>;

interface CellRunRecord {
  readonly state: CellRunState;
  readonly presentation: CellRunPresentation;
}

const cellRunRef = (
  notebookId: NotebookId,
  cellId: NotebookCellId,
): CellRunRef => ({ notebookId, cellId });

/**
 * Owns cell-run state, accepted source, batching, interruption, and cleanup.
 * Platform resources are private to the supplied presentation Adapter.
 */
export class CellRuns extends Context.Service<CellRuns>()("CellRuns", {
  make: Effect.gen(function* () {
    const records = MutableHashMap.empty<CellRunRef, CellRunRecord>();
    const acceptedSourceRef = yield* SubscriptionRef.make(
      HashMap.empty<
        NotebookId,
        HashMap.HashMap<NotebookCellId, Option.Option<string>>
      >(),
    );

    const recordAcceptedSource = (cell: CellRunRef, source: string) =>
      SubscriptionRef.update(acceptedSourceRef, (map) => {
        const notebook = Option.getOrElse(
          HashMap.get(map, cell.notebookId),
          () => HashMap.empty<NotebookCellId, Option.Option<string>>(),
        );
        return HashMap.set(
          map,
          cell.notebookId,
          HashMap.set(notebook, cell.cellId, Option.some(source)),
        );
      });

    const invalidate = (cell: CellRunRef) =>
      SubscriptionRef.update(acceptedSourceRef, (map) => {
        const notebook = Option.getOrElse(
          HashMap.get(map, cell.notebookId),
          () => HashMap.empty<NotebookCellId, Option.Option<string>>(),
        );
        return HashMap.set(
          map,
          cell.notebookId,
          HashMap.set(notebook, cell.cellId, Option.none()),
        );
      });

    const perform = (
      action: Action,
      options: {
        readonly cell: CellRunRef;
        readonly source: string | undefined;
        readonly presentation: CellRunPresentation;
      },
    ) => {
      switch (action._tag) {
        case "RecordExecution":
          return options.source === undefined
            ? Effect.logWarning(
                "Cell source unavailable; accepted source was not recorded",
              ).pipe(Effect.annotateLogs({ ...options.cell }))
            : recordAcceptedSource(options.cell, options.source);
        case "InvalidateCell":
          return invalidate(options.cell);
        default:
          return options.presentation.apply(options.cell, action);
      }
    };

    const interruptRecords = (
      targets: ReadonlyArray<readonly [CellRunRef, CellRunRecord]>,
      options: { readonly remove: boolean },
    ) =>
      Effect.forEach(
        targets,
        Effect.fn(function* ([cell, record]) {
          const { entry, actions } = step(record.state, Op.Interrupt());
          if (options.remove) {
            MutableHashMap.remove(records, cell);
          } else {
            MutableHashMap.set(records, cell, { ...record, state: entry });
          }
          yield* Effect.forEach(
            actions,
            (action) =>
              perform(action, {
                cell,
                source: undefined,
                presentation: record.presentation,
              }),
            { discard: true },
          );
        }),
        { discard: true },
      );

    yield* Effect.addFinalizer(() =>
      interruptRecords(EffectArray.fromIterable(records), { remove: true }),
    );

    const acceptOperations = (input: CellRunOperationsInput) => {
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

      return Effect.forEach(
        input.operations,
        (message, index) => {
          const cell = cellRunRef(input.notebookId, message.cell_id);
          const record = Option.getOrElse(
            MutableHashMap.get(records, cell),
            () => ({
              state: makeCellRunState(cell.cellId),
              presentation: input.presentation,
            }),
          );

          const next = transitionCell(record.state.state, message);
          const op = parseOp(next, message);
          if (Option.isNone(op)) {
            MutableHashMap.set(records, cell, {
              state: { ...record.state, state: next },
              presentation: input.presentation,
            });
            return Effect.logWarning(
              "Queued cell-op missing run_id; cannot track execution",
            ).pipe(
              Effect.annotateLogs({
                ...cell,
                status: message.status,
              }),
            );
          }

          const result = step(record.state, op.value);
          MutableHashMap.set(records, cell, {
            state: result.entry,
            presentation: input.presentation,
          });
          const source = input.sourceByCell.get(cell.cellId);

          return Effect.forEach(
            result.actions,
            (action) => {
              if (
                renderIndex.get(cell.cellId) !== index &&
                (action._tag === "EmitOutputs" ||
                  action._tag === "FinalizeOutputs")
              ) {
                return Effect.void;
              }
              return perform(action, {
                cell,
                source,
                presentation: input.presentation,
              });
            },
            { discard: true },
          );
        },
        { discard: true },
      );
    };

    return {
      isStale: (cell: CellRunSnapshot) =>
        SubscriptionRef.get(acceptedSourceRef).pipe(
          Effect.map((map) =>
            Option.match(
              HashMap.get(map, cell.notebookId).pipe(
                Option.flatMap(HashMap.get(cell.cellId)),
              ),
              {
                onNone: () => false,
                onSome: (acceptedSource) =>
                  Option.match(acceptedSource, {
                    onNone: () => true,
                    onSome: (source) => source !== cell.source,
                  }),
              },
            ),
          ),
        ),
      get changes(): Stream.Stream<void> {
        return Stream.map(
          SubscriptionRef.changes(acceptedSourceRef),
          constVoid,
        );
      },
      accept: (input: CellRunInput) =>
        CellRunInput.$match(input, {
          Operations: acceptOperations,
          Interrupted: ({ notebookId }) =>
            interruptRecords(
              EffectArray.fromIterable(records).filter(
                ([cell]) => cell.notebookId === notebookId,
              ),
              { remove: false },
            ),
          CellsRemoved: ({ notebookId, cellIds }) => {
            const removed = new Set(cellIds);
            const targets = EffectArray.fromIterable(records).filter(
              ([cell]) =>
                cell.notebookId === notebookId && removed.has(cell.cellId),
            );
            return Effect.all([
              interruptRecords(targets, { remove: true }),
              SubscriptionRef.update(acceptedSourceRef, (map) => {
                const notebook = HashMap.get(map, notebookId);
                if (Option.isNone(notebook)) return map;
                const updated = cellIds.reduce(
                  (cells, cellId) => HashMap.remove(cells, cellId),
                  notebook.value,
                );
                return HashMap.isEmpty(updated)
                  ? HashMap.remove(map, notebookId)
                  : HashMap.set(map, notebookId, updated);
              }),
            ]).pipe(Effect.asVoid);
          },
        }),
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
