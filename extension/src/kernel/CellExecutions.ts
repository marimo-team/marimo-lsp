import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Equal,
  Exit,
  HashMap,
  HashSet,
  Layer,
  Option,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import type * as vscode from "vscode";

import { NotebookEditorRegistry } from "../notebook/NotebookEditorRegistry.ts";
import type { OpenNotebookSession } from "../notebook/NotebookSessions.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  extractCellIdFromCellMessage,
  MarimoNotebookDocument,
  type NotebookCellId,
  type NotebookId,
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

declare const WireCellOpTypeId: unique symbol;

/** Decoded protocol data that has not yet been causally correlated. */
export type WireCellOp = CellOperationNotification & {
  readonly [WireCellOpTypeId]: typeof WireCellOpTypeId;
};

/** Marks an already-decoded cell operation as foreign wire data. */
export const WireCellOp = (operation: CellOperationNotification): WireCellOp =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- nominal marker only
  operation as WireCellOp;

export class RunCorrelationError extends Data.TaggedError(
  "RunCorrelationError",
)<{
  readonly cellId: NotebookCellId;
  readonly expectedRunId: string | undefined;
  readonly receivedRunId: string | undefined;
  readonly status: CellOperationNotification["status"];
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
  readonly apply: (
    operation: WireCellOp,
  ) => Effect.Effect<void, RunCorrelationError>;
  readonly interrupt: Effect.Effect<void>;
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

interface NotebookEntry {
  readonly session: OpenNotebookSession;
  readonly executions: NotebookExecutions;
  readonly close: Effect.Effect<void>;
  readonly refreshStale: Effect.Effect<void>;
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

/** Owns one ordered collection of cell runs per exact notebook session. */
export class CellExecutions extends Context.Service<CellExecutions>()(
  "CellExecutions",
  {
    make: Effect.gen(function* () {
      const code = yield* VsCode;
      const editorRegistry = yield* NotebookEditorRegistry;
      const serviceScope = yield* Effect.scope;
      const notebooks = new Map<NotebookId, NotebookEntry>();
      const allStaleCells = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, HashSet.HashSet<NotebookCellId>>(),
      );

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
          yield* code.commands.setContext(
            "marimo.notebook.hasStaleCells",
            hasStaleCells,
          );
        },
      );

      yield* Effect.forkScoped(
        SubscriptionRef.changes(allStaleCells).pipe(
          Stream.runForEach(updateStaleContext),
        ),
      );
      yield* Effect.forkScoped(
        editorRegistry.streamActiveNotebookChanges.pipe(
          Stream.runForEach(updateStaleContext),
        ),
      );
      yield* Effect.forkScoped(
        code.workspace.notebookDocumentChanges.pipe(
          Stream.filter((event) =>
            event.cellChanges.some((change) => change.document !== undefined),
          ),
          Stream.runForEach((event) => {
            const notebook = MarimoNotebookDocument.tryFrom(event.notebook);
            if (Option.isNone(notebook)) return Effect.void;
            const entry = notebooks.get(notebook.value.id);
            return entry?.session.document === event.notebook
              ? entry.refreshStale
              : Effect.void;
          }),
        ),
      );

      const makeNotebook = Effect.fn("CellExecutions.makeNotebook")(function* (
        session: OpenNotebookSession,
        binding: NotebookExecutionBinding,
      ) {
        const notebook = MarimoNotebookDocument.from(session.document);
        const notebookId = notebook.id;
        const records = new Map<NotebookCellId, CellRecord>();
        const submittedSources = new Map<
          NotebookCellId,
          Array<SubmittedSource>
        >();
        const staleRef = yield* SubscriptionRef.make(
          HashSet.empty<NotebookCellId>(),
        );
        const ordering = Semaphore.makeUnsafe(1);
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

        const refreshStale = Effect.gen(function* () {
          let next = HashSet.empty<NotebookCellId>();
          const currentSources = new Map<NotebookCellId, string>();
          for (const cell of notebook.getCells()) {
            if (Option.isSome(cell.id)) {
              currentSources.set(cell.id.value, cell.document.getText());
            }
          }
          for (const [cellId, record] of records) {
            const stale = AcceptedSource.$match(record.run.acceptedSource, {
              Unknown: () => false,
              Invalidated: () => true,
              Accepted: ({ source }) =>
                currentSources.get(cellId) !== undefined &&
                source !== currentSources.get(cellId),
            });
            if (stale) next = HashSet.add(next, cellId);
          }
          yield* publishStale(next);
        });

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

        const correlate = Effect.fn("NotebookExecutions.correlate")(function* (
          record: CellRecord,
          wire: WireCellOp,
        ) {
          const cellId = extractCellIdFromCellMessage(wire);
          const activeRunId =
            record.run.phase._tag === "Queued" ||
            record.run.phase._tag === "Running"
              ? record.run.phase.runId
              : undefined;
          const receivedRunId =
            typeof wire.run_id === "string" && wire.run_id.length > 0
              ? wire.run_id
              : undefined;

          if (
            wire.status !== "queued" &&
            receivedRunId !== undefined &&
            receivedRunId !== activeRunId
          ) {
            return yield* new RunCorrelationError({
              cellId,
              expectedRunId: activeRunId,
              receivedRunId,
              status: wire.status,
            });
          }

          const next = transitionCell(record.run.state, wire);
          const op = parseOp(next, wire, RunId(crypto.randomUUID()));
          if (Option.isNone(op)) {
            return yield* new RunCorrelationError({
              cellId,
              expectedRunId: activeRunId,
              receivedRunId,
              status: wire.status,
            });
          }
          return op.value;
        });

        const takeSubmittedSource = (cellId: NotebookCellId) => {
          const pending = submittedSources.get(cellId);
          if (pending === undefined || pending.length === 0) return undefined;
          const submitted = pending.shift();
          if (pending.length === 0) submittedSources.delete(cellId);
          return submitted?.source;
        };

        const currentSource = (cellId: NotebookCellId) => {
          for (const cell of notebook.getCells()) {
            if (Option.isSome(cell.id) && cell.id.value === cellId) {
              return cell.document.getText();
            }
          }
          return undefined;
        };

        const apply = (wire: WireCellOp) =>
          ordering.withPermit(
            Effect.gen(function* () {
              if (closed) return;
              const cellId = extractCellIdFromCellMessage(wire);
              const record = records.get(cellId) ?? {
                run: makeCellRunState(cellId),
                drive: Option.none<DriveBinding>(),
              };
              const op = yield* correlate(record, wire).pipe(
                Effect.tapError(() =>
                  wire.status === "queued"
                    ? Effect.sync(() => {
                        takeSubmittedSource(cellId);
                      })
                    : Effect.void,
                ),
              );
              if (
                wire.status === "idle" &&
                record.run.phase._tag !== "Queued" &&
                record.run.phase._tag !== "Running"
              ) {
                takeSubmittedSource(cellId);
              }
              const currentDrive = yield* binding.getDrive;
              const source =
                op._tag === "Queue"
                  ? (takeSubmittedSource(cellId) ?? currentSource(cellId))
                  : undefined;
              const result = step(record.run, op, source);
              const opened = openedRunIds(result.commands);
              records.set(cellId, {
                run: result.entry,
                drive: driveAfter(result.entry, record, currentDrive, opened),
              });
              yield* refreshStale;

              const cell = cellRef(notebookId, cellId);
              for (const command of result.commands) {
                yield* drive({
                  cell,
                  command,
                  drive: driveFor(command, record, currentDrive, opened),
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
        ) =>
          Effect.gen(function* () {
            for (const [cellId, record] of records) {
              if (!target(cellId)) continue;
              const result = step(record.run, Op.Interrupt());
              const cell = cellRef(notebookId, cellId);
              for (const command of result.commands) {
                yield* drive({
                  cell,
                  command,
                  drive: driveFor(command, record, Option.none(), noOpenedRuns),
                });
              }
              if (remove) records.delete(cellId);
              else {
                records.set(cellId, {
                  run: result.entry,
                  drive: Option.none(),
                });
              }
            }
            yield* refreshStale;
          });

        const interrupt = ordering.withPermit(
          Effect.gen(function* () {
            if (closed) return;
            submittedSources.clear();
            yield* release(() => true, false);
          }),
        );

        const remove = (cellId: NotebookCellId) =>
          ordering.withPermit(
            Effect.gen(function* () {
              if (closed) return;
              yield* release((candidate) => candidate === cellId, true);
              submittedSources.delete(cellId);
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

        const close = ordering.withPermit(
          Effect.gen(function* () {
            if (closed) return;
            closed = true;
            yield* release(() => true, true);
            submittedSources.clear();
            yield* SubscriptionRef.set(staleRef, HashSet.empty());
            yield* SubscriptionRef.update(allStaleCells, (all) =>
              HashMap.remove(all, notebookId),
            );
          }),
        );

        const executions: NotebookExecutions = {
          apply,
          interrupt,
          remove,
          submit,
          staleCells: {
            current: SubscriptionRef.get(staleRef),
            changes: SubscriptionRef.changes(staleRef),
          },
        };
        return { executions, close, refreshStale } as const;
      });

      const open = Effect.fn("CellExecutions.open")(function* (
        session: OpenNotebookSession,
        binding: NotebookExecutionBinding,
      ) {
        const notebookId = MarimoNotebookDocument.from(session.document).id;
        const existing = notebooks.get(notebookId);
        if (existing?.session === session) return existing.executions;
        if (existing !== undefined) yield* existing.close;

        const made = yield* makeNotebook(session, binding);
        const entry: NotebookEntry = { session, ...made };
        notebooks.set(notebookId, entry);
        yield* made.refreshStale;

        yield* Deferred.await(session.invalidated).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              if (notebooks.get(notebookId)?.session !== session) {
                return Effect.void;
              }
              notebooks.delete(notebookId);
              return made.close;
            }),
          ),
          Effect.forkIn(serviceScope),
        );
        return made.executions;
      });

      yield* Effect.addFinalizer(() =>
        Effect.forEach(notebooks.values(), (entry) => entry.close, {
          discard: true,
        }),
      );

      return {
        open,
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
    Layer.provide([NotebookEditorRegistry.layer]),
  );
}
