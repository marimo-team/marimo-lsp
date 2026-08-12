import {
  Cause,
  Context,
  Effect,
  Equal,
  Exit,
  Layer,
  MutableHashMap,
  Option,
  Stream,
  SubscriptionRef,
  Array as EffectArray,
} from "effect";
import { constVoid } from "effect/Function";

import { NotebookEditorRegistry } from "../notebook/NotebookEditorRegistry.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  extractCellIdFromCellMessage,
  type MarimoNotebookCell,
  MarimoNotebookDocument,
  type NotebookCellId,
  type NotebookId,
} from "../schemas/MarimoNotebookDocument.ts";
import type { CellOperationNotification } from "../types.ts";
import {
  AcceptedSource,
  CellCommand,
  type CellRunEntry,
  makeCellRunEntry,
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

/** Effectful capability supplied by a host adapter. */
export type Drive = (
  cell: CellRef,
  command: CellCommand,
) => Effect.Effect<void>;

interface CellExecutionKey {
  readonly notebookId: NotebookId;
  readonly cellId: NotebookCellId;
}

interface DriveBinding {
  readonly runId: RunId;
  readonly value: Drive;
}

interface RunRecord {
  readonly entry: CellRunEntry;
  readonly drive: Option.Option<DriveBinding>;
}

interface SubmittedSource {
  readonly token: symbol;
  readonly source: string;
}

// MutableHashMap compares plain object keys by structure.
const cellExecutionKey = (
  notebookId: NotebookId,
  cellId: NotebookCellId,
): CellExecutionKey => ({ notebookId, cellId });

const cellRef = (key: CellExecutionKey): CellRef => key;

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
  record: RunRecord,
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
  record: RunRecord,
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
  entry: CellRunEntry,
  record: RunRecord,
  current: Option.Option<Drive>,
  opened: ReadonlySet<RunId>,
): Option.Option<DriveBinding> => {
  if (entry.phase._tag !== "Queued" && entry.phase._tag !== "Running") {
    return Option.none();
  }
  const runId = entry.phase.runId;
  return resolveDriveBinding(runId, record, current, opened);
};

/**
 * Owns cell records and turns kernel operations into ordered host commands.
 * Host resources stay private to the supplied {@link Drive} adapter.
 */
export class CellExecutions extends Context.Service<CellExecutions>()(
  "CellExecutions",
  {
    make: Effect.gen(function* () {
      const code = yield* VsCode;
      const editorRegistry = yield* NotebookEditorRegistry;
      const records = MutableHashMap.empty<CellExecutionKey, RunRecord>();
      const submittedSources = MutableHashMap.empty<
        CellExecutionKey,
        Array<SubmittedSource>
      >();
      const revision = yield* SubscriptionRef.make(0);

      const emptyRecord = (cellId: NotebookCellId): RunRecord => ({
        entry: makeCellRunEntry(cellId),
        drive: Option.none(),
      });

      const isCellStale = (cell: MarimoNotebookCell) => {
        const cellId = cell.id;
        if (Option.isNone(cellId)) return Effect.succeed(false);
        const currentCode = cell.document.getText();
        return Effect.sync(() =>
          Option.match(
            MutableHashMap.get(
              records,
              cellExecutionKey(cell.notebook.id, cellId.value),
            ),
            {
              onNone: () => false,
              onSome: ({ entry }) =>
                AcceptedSource.$match(entry.acceptedSource, {
                  Unknown: () => false,
                  Invalidated: () => true,
                  Accepted: ({ source }) => source !== currentCode,
                }),
            },
          ),
        );
      };

      const updateStaleContext = Effect.fn(function* () {
        const activeNotebook = yield* editorRegistry.getActiveNotebookUri;
        const hasStaleCells = yield* Option.match(activeNotebook, {
          onNone: () => Effect.succeed(false),
          onSome: (notebookId) =>
            Effect.gen(function* () {
              const editor =
                yield* editorRegistry.getLastNotebookEditor(notebookId);
              if (Option.isNone(editor)) return false;
              const notebook = MarimoNotebookDocument.tryFrom(
                editor.value.notebook,
              );
              if (Option.isNone(notebook)) return false;
              for (const cell of notebook.value.getCells()) {
                if (yield* isCellStale(cell)) return true;
              }
              return false;
            }),
        });
        yield* code.commands.setContext(
          "marimo.notebook.hasStaleCells",
          hasStaleCells,
        );
      });

      const contentChanges = code.workspace.notebookDocumentChanges.pipe(
        Stream.filter((event) => {
          if (Option.isNone(MarimoNotebookDocument.tryFrom(event.notebook))) {
            return false;
          }
          return event.cellChanges.some(
            (change) => change.document !== undefined,
          );
        }),
      );

      yield* Effect.forkScoped(
        SubscriptionRef.changes(revision).pipe(
          Stream.runForEach(updateStaleContext),
        ),
      );
      yield* Effect.forkScoped(
        editorRegistry.streamActiveNotebookChanges.pipe(
          Stream.runForEach(updateStaleContext),
        ),
      );
      yield* Effect.forkScoped(
        contentChanges.pipe(
          Stream.mapEffect(updateStaleContext),
          Stream.runDrain,
        ),
      );

      const updateAcceptedSource = (
        cell: MarimoNotebookCell,
        acceptedSource: AcceptedSource,
      ) => {
        const cellId = cell.id;
        if (Option.isNone(cellId)) return Effect.void;
        const key = cellExecutionKey(cell.notebook.id, cellId.value);
        return Effect.sync(() => {
          const record = Option.getOrElse(
            MutableHashMap.get(records, key),
            () => emptyRecord(cellId.value),
          );
          if (Equal.equals(record.entry.acceptedSource, acceptedSource)) {
            return false;
          }
          MutableHashMap.set(records, key, {
            ...record,
            entry: { ...record.entry, acceptedSource },
          });
          return true;
        }).pipe(
          Effect.flatMap((changed) =>
            changed
              ? SubscriptionRef.update(revision, (value) => value + 1)
              : Effect.void,
          ),
        );
      };

      const run = (
        key: CellExecutionKey,
        command: CellCommand,
        drive: Option.Option<Drive>,
      ) =>
        Option.match(drive, {
          onNone: () =>
            Effect.logWarning("Cell run has no Drive; skipping command").pipe(
              Effect.annotateLogs({
                ...key,
                command: command._tag,
                ...("runId" in command ? { runId: command.runId } : {}),
              }),
            ),
          onSome: (apply) =>
            apply(cellRef(key), command).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("Failed to drive cell command").pipe(
                      Effect.annotateLogs({
                        cause,
                        ...key,
                        command: command._tag,
                        ...("runId" in command ? { runId: command.runId } : {}),
                      }),
                    ),
              ),
            ),
        });

      const takeSubmittedSource = (key: CellExecutionKey) => {
        const pending = MutableHashMap.get(submittedSources, key);
        if (Option.isNone(pending) || pending.value.length === 0) {
          return undefined;
        }
        const [submitted, ...remaining] = pending.value;
        if (remaining.length === 0)
          MutableHashMap.remove(submittedSources, key);
        else MutableHashMap.set(submittedSources, key, remaining);
        return submitted?.source;
      };

      return {
        isCellStale,
        recordExecution: (cell: MarimoNotebookCell) =>
          updateAcceptedSource(
            cell,
            AcceptedSource.Accepted({ source: cell.document.getText() }),
          ),
        invalidateCell: (cell: MarimoNotebookCell) =>
          updateAcceptedSource(cell, AcceptedSource.Invalidated()),
        removeCell: (notebookId: NotebookId, cellId: NotebookCellId) =>
          Effect.gen(function* () {
            const key = cellExecutionKey(notebookId, cellId);
            const record = MutableHashMap.get(records, key);
            yield* Effect.sync(() =>
              MutableHashMap.remove(submittedSources, key),
            );
            if (Option.isNone(record)) return;

            const result = step(record.value.entry, Op.Interrupt());
            yield* Effect.sync(() => MutableHashMap.remove(records, key));
            yield* SubscriptionRef.update(revision, (value) => value + 1);

            for (const command of result.commands) {
              yield* run(
                key,
                command,
                driveFor(command, record.value, Option.none(), noOpenedRuns),
              );
            }
          }),
        submit: <A, E, R>(
          notebookId: NotebookId,
          cells: ReadonlyArray<{
            readonly cellId: NotebookCellId;
            readonly source: string;
          }>,
          send: Effect.Effect<A, E, R>,
        ) => {
          const token = Symbol("cell submission");
          const register = Effect.sync(() => {
            for (const { cellId, source } of cells) {
              const key = cellExecutionKey(notebookId, cellId);
              const pending = Option.getOrElse(
                MutableHashMap.get(submittedSources, key),
                () => [],
              );
              MutableHashMap.set(submittedSources, key, [
                ...pending,
                { token, source },
              ]);
            }
          });
          const rollback = Effect.sync(() => {
            for (const { cellId } of cells) {
              const key = cellExecutionKey(notebookId, cellId);
              const pending = MutableHashMap.get(submittedSources, key);
              if (Option.isNone(pending)) continue;
              const remaining = pending.value.filter(
                (submitted) => submitted.token !== token,
              );
              if (remaining.length === 0) {
                MutableHashMap.remove(submittedSources, key);
              } else {
                MutableHashMap.set(submittedSources, key, remaining);
              }
            }
          });
          return register.pipe(
            Effect.andThen(send),
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : rollback,
            ),
          );
        },
        get changes(): Stream.Stream<void> {
          return Stream.merge(
            Stream.map(SubscriptionRef.changes(revision), constVoid),
            Stream.map(contentChanges, constVoid),
          );
        },
        handleInterrupt: (notebookId: NotebookId) =>
          Effect.gen(function* () {
            const targets = EffectArray.fromIterable(records).filter(
              ([key]) => key.notebookId === notebookId,
            );
            for (const [key, record] of targets) {
              const result = step(record.entry, Op.Interrupt());
              yield* Effect.sync(() =>
                MutableHashMap.set(records, key, {
                  ...record,
                  entry: result.entry,
                  drive: Option.none(),
                }),
              );
              for (const command of result.commands) {
                yield* run(
                  key,
                  command,
                  driveFor(command, record, Option.none(), noOpenedRuns),
                );
              }
            }
          }),
        handleOperation: (
          message: CellOperationNotification,
          options: {
            notebookId: NotebookId;
            source?: string;
            drive: Drive;
            renderOutput?: boolean;
          },
        ) =>
          Effect.gen(function* () {
            const cellId = extractCellIdFromCellMessage(message);
            const key = cellExecutionKey(options.notebookId, cellId);
            const record = Option.getOrElse(
              MutableHashMap.get(records, key),
              () => emptyRecord(cellId),
            );

            const activeRunId =
              record.entry.phase._tag === "Queued" ||
              record.entry.phase._tag === "Running"
                ? record.entry.phase.runId
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

            const next = transitionCell(record.entry.state, message);
            const op = parseOp(next, message, RunId(crypto.randomUUID()));
            if (Option.isNone(op)) {
              yield* Effect.logWarning(
                "Queued cell-op missing run_id; cannot track execution",
              ).pipe(Effect.annotateLogs({ cellId, status: message.status }));
              yield* Effect.sync(() =>
                MutableHashMap.set(records, key, {
                  ...record,
                  entry: { ...record.entry, state: next },
                }),
              );
              return;
            }

            const source =
              op.value._tag === "Queue"
                ? (takeSubmittedSource(key) ?? options.source)
                : undefined;
            const result = step(record.entry, op.value, source);
            const opened = openedRunIds(result.commands);
            yield* Effect.sync(() =>
              MutableHashMap.set(records, key, {
                entry: result.entry,
                drive: driveAfter(
                  result.entry,
                  record,
                  Option.some(options.drive),
                  opened,
                ),
              }),
            );
            if (
              !Equal.equals(
                result.entry.acceptedSource,
                record.entry.acceptedSource,
              )
            ) {
              yield* SubscriptionRef.update(revision, (value) => value + 1);
            }

            for (const command of result.commands) {
              if (
                options.renderOutput === false &&
                command._tag === "RenderOutputs"
              ) {
                continue;
              }
              yield* run(
                key,
                command,
                driveFor(command, record, Option.some(options.drive), opened),
              );
            }
          }).pipe(
            Effect.annotateLogs({
              cellId: extractCellIdFromCellMessage(message),
            }),
          ),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([NotebookEditorRegistry.layer]),
  );
}
