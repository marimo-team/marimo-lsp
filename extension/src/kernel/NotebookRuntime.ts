import {
  Effect,
  Exit,
  Option,
  PubSub,
  STM,
  Stream,
  TSemaphore,
  Array as EffectArray,
} from "effect";

import { SCRATCH_CELL_ID } from "../constants.ts";
import {
  MarimoClient,
  type MarimoClientStartError,
  type MarimoCommandError,
} from "../lsp/MarimoClient.ts";
import type { NotebookId } from "../schemas/MarimoNotebookDocument.ts";
import type {
  CellOperationNotification,
  MarimoApiMethod,
  MarimoApiParams,
  MarimoOperation,
} from "../types.ts";

type InnerRequest<K extends MarimoApiMethod> =
  MarimoApiParams<K> extends { readonly inner: infer Request }
    ? Request
    : never;

/**
 * Commands and scratchpad execution for one notebook.
 *
 * The notebook ID is captured by the handle instead of repeated at every
 * call site.
 */
export interface NotebookHandle {
  readonly id: NotebookId;
  readonly executeCells: (
    request: InnerRequest<"execute-cells">,
    executable: string,
  ) => ReturnType<MarimoClient["executeCells"]>;
  readonly executeScratchpad: (
    code: string,
    executable: string,
  ) => Stream.Stream<
    CellOperationNotification,
    MarimoClientStartError | MarimoCommandError
  >;
  readonly updateUIElements: (
    request: InnerRequest<"update-ui-element">,
  ) => ReturnType<MarimoClient["updateUIElements"]>;
  readonly updateModel: (
    request: InnerRequest<"set-model-value">,
  ) => ReturnType<MarimoClient["updateModel"]>;
  readonly invokeFunction: (
    request: InnerRequest<"invoke-function">,
  ) => ReturnType<MarimoClient["invokeFunction"]>;
  readonly deleteCell: (
    request: InnerRequest<"delete-cell">,
  ) => ReturnType<MarimoClient["deleteCell"]>;
  readonly sendStdin: (
    request: InnerRequest<"send-stdin">,
  ) => ReturnType<MarimoClient["sendStdin"]>;
  readonly interrupt: () => ReturnType<MarimoClient["interrupt"]>;
  readonly close: () => ReturnType<MarimoClient["closeSession"]>;
}

function hasRunId<T extends { run_id?: string | null }>(
  event: T,
): event is T & { run_id: string } {
  return typeof event.run_id === "string" && event.run_id.length > 0;
}

function isCompletedRunFor(runId: string) {
  return (message: MarimoOperation) =>
    message.operation.op === "completed-run" &&
    hasRunId(message.operation) &&
    message.operation.run_id === runId;
}

function isScratchpadOutput(
  operation: MarimoOperation["operation"],
): operation is CellOperationNotification {
  if (operation.op !== "cell-op") return false;
  if (operation.cell_id === SCRATCH_CELL_ID) return true;
  if (operation.console == null) return false;
  return EffectArray.ensure(operation.console).some(
    (output) => output.channel === "stdout" || output.channel === "stderr",
  );
}

/**
 * Owns notebook handles and the single subscription to kernel operations.
 *
 * ```ts
 * const runtime = yield* NotebookRuntime;
 * const notebook = runtime.forNotebook(notebookId);
 *
 * yield* notebook.executeCells(request, executable);
 * yield* notebook.updateUIElements(update);
 * yield* notebook.interrupt();
 * ```
 *
 * Commands still go directly through MarimoClient. This Module does not
 * schedule or merge them.
 */
export class NotebookRuntime extends Effect.Service<NotebookRuntime>()(
  "NotebookRuntime",
  {
    scoped: Effect.gen(function* () {
      const marimo = yield* MarimoClient;
      const operations = yield* PubSub.unbounded<MarimoOperation>();
      const scratchpadLock = yield* STM.commit(TSemaphore.make(1));
      const handles = new Map<NotebookId, NotebookHandle>();

      yield* Effect.addFinalizer(() => PubSub.shutdown(operations));
      yield* Effect.forkScoped(
        marimo
          .operations()
          .pipe(
            Stream.runForEach((operation) =>
              PubSub.publish(operations, operation),
            ),
          ),
      );

      const makeHandle = (notebookId: NotebookId): NotebookHandle => ({
        id: notebookId,
        executeCells: (request, executable) =>
          marimo.executeCells({
            notebookUri: notebookId,
            executable,
            inner: request,
          }),
        executeScratchpad: (code, executable) =>
          Stream.unwrapScoped(
            Effect.gen(function* () {
              yield* TSemaphore.withPermitsScoped(scratchpadLock, 1);

              const subscription = yield* PubSub.subscribe(operations);
              const runId = crypto.randomUUID();
              yield* marimo.executeScratchpad({
                notebookUri: notebookId,
                executable,
                inner: { code, runId },
              });

              yield* Effect.addFinalizer((exit) =>
                Exit.isInterrupted(exit)
                  ? marimo
                      .interrupt({ notebookUri: notebookId, inner: {} })
                      .pipe(
                        Effect.catchAllCause((cause) =>
                          Effect.logWarning(
                            "Failed to interrupt kernel after scratchpad stream was abandoned",
                          ).pipe(Effect.annotateLogs({ cause })),
                        ),
                      )
                  : Effect.void,
              );

              return Stream.fromQueue(subscription).pipe(
                Stream.filter(
                  (operation) => operation.notebookUri === notebookId,
                ),
                Stream.takeUntil(isCompletedRunFor(runId)),
                Stream.filterMap(({ operation }) =>
                  isScratchpadOutput(operation)
                    ? Option.some(operation)
                    : Option.none(),
                ),
              );
            }),
          ),
        updateUIElements: (request) =>
          marimo.updateUIElements({
            notebookUri: notebookId,
            inner: request,
          }),
        updateModel: (request) =>
          marimo.updateModel({
            notebookUri: notebookId,
            inner: request,
          }),
        invokeFunction: (request) =>
          marimo.invokeFunction({
            notebookUri: notebookId,
            inner: request,
          }),
        deleteCell: (request) =>
          marimo.deleteCell({
            notebookUri: notebookId,
            inner: request,
          }),
        sendStdin: (request) =>
          marimo.sendStdin({
            notebookUri: notebookId,
            inner: request,
          }),
        interrupt: () =>
          marimo.interrupt({ notebookUri: notebookId, inner: {} }),
        close: () =>
          marimo.closeSession({ notebookUri: notebookId, inner: {} }),
      });

      return {
        forNotebook(notebookId: NotebookId) {
          const existing = handles.get(notebookId);
          if (existing !== undefined) return existing;

          const handle = makeHandle(notebookId);
          handles.set(notebookId, handle);
          return handle;
        },
        operations: () => Stream.fromPubSub(operations),
      };
    }),
  },
) {}
