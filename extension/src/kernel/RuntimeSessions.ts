import {
  Data,
  Effect,
  Exit,
  HashMap,
  Option,
  PubSub,
  Ref,
  Scope,
  Stream,
  SynchronizedRef,
  Array as EffectArray,
} from "effect";

import { assert } from "../assert.ts";
import { SCRATCH_CELL_ID } from "../constants.ts";
import {
  type ExecuteCommandError,
  LanguageClient,
  type LanguageClientStartError,
} from "../lsp/LanguageClient.ts";
import type { NotebookId } from "../schemas/MarimoNotebookDocument.ts";
import type {
  DeleteCellRequest,
  CellOperationNotification,
  ExecuteCellsRequest,
  InvokeFunctionRequest,
  MarimoCommand,
  MarimoLspNotificationOf,
  ModelRequest,
  Notification,
  SendStdinRequest,
  UpdateUIElementRequest,
} from "../types.ts";
import {
  makeRuntimeCommandQueue,
  RuntimeCommandQueueClosedError,
} from "./RuntimeCommandQueue.ts";

export type MarimoOperation = MarimoLspNotificationOf<"marimo/operation">;

type RuntimeRequest = Data.TaggedEnum<{
  Api: { readonly command: MarimoCommand };
  UIState: { readonly request: UpdateUIElementRequest };
  ModelState: {
    readonly requests: ReadonlyMap<ModelRequest["modelId"], ModelRequest>;
  };
}>;
const RuntimeRequest = Data.taggedEnum<RuntimeRequest>();

type RuntimeSendError =
  | ExecuteCommandError
  | LanguageClientStartError
  | RuntimeCommandQueueClosedError;

/**
 * One live marimo runtime, identified by its notebook URI.
 *
 * Operations are ordered as received from the language server. The stream ends
 * when this session is closed. UI and model state may merge while waiting to
 * send; function calls and custom model messages are always sent in order.
 */
export interface RuntimeSession {
  readonly notebookUri: NotebookId;
  readonly operations: () => Stream.Stream<Notification>;
  readonly executeCells: (
    request: ExecuteCellsRequest,
    executable: string,
  ) => Effect.Effect<void, RuntimeSendError>;
  /**
   * Run isolated code and stream its output until the matching run completes.
   * Only one scratchpad runs at a time within this session.
   */
  readonly executeScratchpad: (
    code: string,
    executable: string,
  ) => Stream.Stream<CellOperationNotification, RuntimeSendError>;
  readonly updateUIElements: (
    request: UpdateUIElementRequest,
  ) => Effect.Effect<void, RuntimeCommandQueueClosedError>;
  readonly updateModel: (
    request: ModelRequest,
  ) => Effect.Effect<void, RuntimeSendError>;
  readonly invokeFunction: (
    request: InvokeFunctionRequest,
  ) => Effect.Effect<void, RuntimeSendError>;
  readonly deleteCell: (
    request: DeleteCellRequest,
  ) => Effect.Effect<void, RuntimeSendError>;
  readonly sendStdin: (
    request: SendStdinRequest,
  ) => Effect.Effect<void, RuntimeSendError>;
  readonly interrupt: () => Effect.Effect<void, RuntimeSendError>;
  readonly close: () => Effect.Effect<void, RuntimeSendError>;
  readonly shutdown: () => Effect.Effect<void>;
}

interface SessionEntry {
  readonly token: object;
  readonly session: RuntimeSession;
  readonly operations: PubSub.PubSub<Notification>;
  readonly scope: Scope.CloseableScope;
}

function modelCommand(
  notebookUri: NotebookId,
  request: ModelRequest,
): MarimoCommand {
  return {
    command: "marimo.api",
    params: {
      method: "set-model-value",
      params: { notebookUri, inner: request },
    },
  };
}

function invokeFunctionCommand(
  notebookUri: NotebookId,
  request: InvokeFunctionRequest,
): MarimoCommand {
  return {
    command: "marimo.api",
    params: {
      method: "invoke-function",
      params: { notebookUri, inner: request },
    },
  };
}

function uiCommand(
  notebookUri: NotebookId,
  request: UpdateUIElementRequest,
): MarimoCommand {
  return {
    command: "marimo.api",
    params: {
      method: "update-ui-element",
      params: { notebookUri, inner: request },
    },
  };
}

function executeCellsCommand(
  notebookUri: NotebookId,
  executable: string,
  request: ExecuteCellsRequest,
): MarimoCommand {
  return {
    command: "marimo.api",
    params: {
      method: "execute-cells",
      params: { notebookUri, executable, inner: request },
    },
  };
}

function executeScratchpadCommand(
  notebookUri: NotebookId,
  executable: string,
  code: string,
  runId: string,
): MarimoCommand {
  return {
    command: "marimo.api",
    params: {
      method: "execute-scratchpad",
      params: {
        notebookUri,
        executable,
        inner: { code, runId },
      },
    },
  };
}

function deleteCellCommand(
  notebookUri: NotebookId,
  request: DeleteCellRequest,
): MarimoCommand {
  return {
    command: "marimo.api",
    params: {
      method: "delete-cell",
      params: { notebookUri, inner: request },
    },
  };
}

function sendStdinCommand(
  notebookUri: NotebookId,
  request: SendStdinRequest,
): MarimoCommand {
  return {
    command: "marimo.api",
    params: {
      method: "send-stdin",
      params: { notebookUri, inner: request },
    },
  };
}

function interruptCommand(notebookUri: NotebookId): MarimoCommand {
  return {
    command: "marimo.api",
    params: {
      method: "interrupt",
      params: { notebookUri, inner: {} },
    },
  };
}

function closeSessionCommand(notebookUri: NotebookId): MarimoCommand {
  return {
    command: "marimo.api",
    params: {
      method: "close-session",
      params: { notebookUri, inner: {} },
    },
  };
}

function hasConsoleOutput(operation: CellOperationNotification): boolean {
  if (operation.console == null) {
    return false;
  }
  return EffectArray.ensure(operation.console).some(
    (output) => output.channel === "stdout" || output.channel === "stderr",
  );
}

function isScratchpadOutput(
  operation: Notification,
): operation is CellOperationNotification {
  return (
    operation.op === "cell-op" &&
    (operation.cell_id === SCRATCH_CELL_ID || hasConsoleOutput(operation))
  );
}

function isCompletedRunFor(runId: string) {
  return (operation: Notification): boolean =>
    operation.op === "completed-run" && operation.run_id === runId;
}

function mergeUIState(
  older: UpdateUIElementRequest,
  newer: UpdateUIElementRequest,
): UpdateUIElementRequest {
  const values = new Map(
    older.objectIds.map((objectId, index) => [objectId, older.values[index]]),
  );
  for (const [index, objectId] of newer.objectIds.entries()) {
    values.set(objectId, newer.values[index]);
  }
  return {
    ...newer,
    objectIds: [...values.keys()],
    values: [...values.values()],
  };
}

function mergeModelUpdate(
  older: ModelRequest,
  newer: ModelRequest,
): ModelRequest {
  if (older.message.method !== "update" || newer.message.method !== "update") {
    return newer;
  }

  const updatedKeys = new Set(Object.keys(newer.message.state));
  const buffers = new Map<
    string,
    {
      readonly path: ReadonlyArray<string | number>;
      readonly buffer: ModelRequest["buffers"][number];
    }
  >();

  for (const [index, path] of older.message.bufferPaths.entries()) {
    const buffer = older.buffers[index];
    if (buffer !== undefined && !updatedKeys.has(String(path[0]))) {
      buffers.set(JSON.stringify(path), { path, buffer });
    }
  }
  for (const [index, path] of newer.message.bufferPaths.entries()) {
    const buffer = newer.buffers[index];
    if (buffer !== undefined) {
      buffers.set(JSON.stringify(path), { path, buffer });
    }
  }

  return {
    ...newer,
    message: {
      method: "update",
      state: { ...older.message.state, ...newer.message.state },
      bufferPaths: [...buffers.values()].map(({ path }) => [...path]),
    },
    buffers: [...buffers.values()].map(({ buffer }) => buffer),
  };
}

function mergeModelState(
  older: RuntimeRequest,
  newer: RuntimeRequest,
): RuntimeRequest {
  assert(older._tag === "ModelState", "Expected pending model state");
  assert(newer._tag === "ModelState", "Expected new model state");

  const requests = new Map(older.requests);
  for (const [modelId, request] of newer.requests) {
    const previous = requests.get(modelId);
    requests.set(
      modelId,
      previous === undefined ? request : mergeModelUpdate(previous, request),
    );
  }
  return RuntimeRequest.ModelState({ requests });
}

function mergeUIRequest(
  older: RuntimeRequest,
  newer: RuntimeRequest,
): RuntimeRequest {
  assert(older._tag === "UIState", "Expected pending UI state");
  assert(newer._tag === "UIState", "Expected new UI state");
  return RuntimeRequest.UIState({
    request: mergeUIState(older.request, newer.request),
  });
}

/**
 * Owns live runtime sessions and the extension's single subscription to
 * `marimo/operation`.
 *
 * `getOrCreate` returns the current session for a notebook URI. Shutting down
 * the session ends its operation stream and removes it from the registry. A
 * later `getOrCreate` creates a fresh session.
 */
export class RuntimeSessions extends Effect.Service<RuntimeSessions>()(
  "RuntimeSessions",
  {
    scoped: Effect.gen(function* () {
      const client = yield* LanguageClient;
      const allOperations = yield* PubSub.unbounded<MarimoOperation>();
      const sessions = yield* SynchronizedRef.make(
        HashMap.empty<NotebookId, SessionEntry>(),
      );

      const sendRequest = Effect.fn("RuntimeSession.sendRequest")(function* (
        notebookUri: NotebookId,
        runtimeRequest: RuntimeRequest,
      ) {
        return yield* RuntimeRequest.$match(runtimeRequest, {
          Api: ({ command }) =>
            client.executeCommand(command).pipe(Effect.asVoid),
          UIState: ({ request }) =>
            client
              .executeCommand(uiCommand(notebookUri, request))
              .pipe(Effect.asVoid),
          ModelState: ({ requests }) =>
            Effect.forEach(
              requests.values(),
              (request) =>
                client
                  .executeCommand(modelCommand(notebookUri, request))
                  .pipe(Effect.asVoid),
              { discard: true },
            ),
        });
      });

      const shutdown = Effect.fn("RuntimeSessions.shutdown")(function* (
        notebookUri: NotebookId,
        token: object,
      ) {
        yield* SynchronizedRef.updateEffect(
          sessions,
          Effect.fnUntraced(function* (entries) {
            const entry = HashMap.get(entries, notebookUri);
            if (Option.isNone(entry) || entry.value.token !== token) {
              return entries;
            }

            yield* Scope.close(entry.value.scope, Exit.void);
            return HashMap.remove(entries, notebookUri);
          }),
        );
      });

      const ensureCurrent = Effect.fn("RuntimeSessions.ensureCurrent")(
        function* (notebookUri: NotebookId, token: object) {
          const entry = HashMap.get(
            yield* SynchronizedRef.get(sessions),
            notebookUri,
          );
          if (Option.isNone(entry) || entry.value.token !== token) {
            yield* new RuntimeCommandQueueClosedError();
          }
        },
      );

      const makeSession = Effect.fn("RuntimeSessions.makeSession")(function* (
        notebookUri: NotebookId,
      ) {
        const token = {};
        const scope = yield* Scope.make();
        const resources = yield* Scope.extend(
          Effect.gen(function* () {
            const operations = yield* PubSub.unbounded<Notification>();
            yield* Effect.addFinalizer(() => PubSub.shutdown(operations));
            const scratchpadLock = yield* Effect.makeSemaphore(1);
            const queue = yield* makeRuntimeCommandQueue(
              (request: RuntimeRequest) => sendRequest(notebookUri, request),
            );
            return { operations, queue, scratchpadLock };
          }),
          scope,
        );
        const interrupt = Effect.fn("RuntimeSession.interrupt")(function* () {
          yield* ensureCurrent(notebookUri, token);
          yield* client
            .executeCommand(interruptCommand(notebookUri))
            .pipe(Effect.asVoid);
        });
        const session: RuntimeSession = {
          notebookUri,
          operations: () => Stream.fromPubSub(resources.operations),
          executeCells: Effect.fn("RuntimeSession.executeCells")(
            function* (request, executable) {
              yield* resources.queue.send(
                RuntimeRequest.Api({
                  command: executeCellsCommand(
                    notebookUri,
                    executable,
                    request,
                  ),
                }),
              );
            },
          ),
          executeScratchpad: (code, executable) =>
            Stream.unwrapScoped(
              Effect.gen(function* () {
                yield* Effect.acquireRelease(
                  resources.scratchpadLock.take(1),
                  () => resources.scratchpadLock.release(1),
                );

                // Subscribe before sending so an immediate completed-run cannot
                // overtake the stream.
                const operations = yield* PubSub.subscribe(
                  resources.operations,
                );
                const runId = crypto.randomUUID();
                const commandSent = yield* Ref.make(false);

                yield* Effect.addFinalizer((exit) =>
                  Exit.isInterrupted(exit)
                    ? Ref.get(commandSent).pipe(
                        Effect.flatMap((sent) =>
                          sent
                            ? interrupt().pipe(
                                Effect.catchAllCause((cause) =>
                                  Effect.logWarning(
                                    "Failed to interrupt abandoned scratchpad execution",
                                  ).pipe(
                                    Effect.annotateLogs({
                                      cause,
                                      notebookUri,
                                      runId,
                                    }),
                                  ),
                                ),
                              )
                            : Effect.void,
                        ),
                      )
                    : Effect.void,
                );

                // Once queued, finish the send even if the stream is abandoned.
                // The finalizer will then interrupt the run.
                yield* Effect.uninterruptible(
                  resources.queue
                    .send(
                      RuntimeRequest.Api({
                        command: executeScratchpadCommand(
                          notebookUri,
                          executable,
                          code,
                          runId,
                        ),
                      }),
                    )
                    .pipe(Effect.andThen(Ref.set(commandSent, true))),
                );

                return Stream.fromQueue(operations).pipe(
                  Stream.takeUntil(isCompletedRunFor(runId)),
                  Stream.filter(isScratchpadOutput),
                );
              }),
            ),
          updateUIElements: Effect.fn("RuntimeSession.updateUIElements")(
            function* (request) {
              if (
                request.objectIds.length === 0 ||
                request.objectIds.length !== request.values.length
              ) {
                yield* Effect.logWarning(
                  "Dropping invalid UI element update",
                ).pipe(
                  Effect.annotateLogs({
                    notebookUri,
                    objectIdCount: request.objectIds.length,
                    valueCount: request.values.length,
                  }),
                );
                return;
              }

              yield* resources.queue.enqueueState({
                kind: "ui-elements",
                command: RuntimeRequest.UIState({ request }),
                merge: mergeUIRequest,
              });
            },
          ),
          updateModel: Effect.fn("RuntimeSession.updateModel")(
            function* (request) {
              if (request.message.method === "custom") {
                yield* resources.queue.send(
                  RuntimeRequest.Api({
                    command: modelCommand(notebookUri, request),
                  }),
                );
                return;
              }

              yield* resources.queue.enqueueState({
                kind: "models",
                command: RuntimeRequest.ModelState({
                  requests: new Map([[request.modelId, request]]),
                }),
                merge: mergeModelState,
              });
              return;
            },
          ),
          invokeFunction: Effect.fn("RuntimeSession.invokeFunction")(
            function* (request) {
              yield* resources.queue.send(
                RuntimeRequest.Api({
                  command: invokeFunctionCommand(notebookUri, request),
                }),
              );
            },
          ),
          deleteCell: Effect.fn("RuntimeSession.deleteCell")(
            function* (request) {
              yield* resources.queue.send(
                RuntimeRequest.Api({
                  command: deleteCellCommand(notebookUri, request),
                }),
              );
            },
          ),
          sendStdin: Effect.fn("RuntimeSession.sendStdin")(function* (request) {
            yield* resources.queue.send(
              RuntimeRequest.Api({
                command: sendStdinCommand(notebookUri, request),
              }),
            );
          }),
          interrupt,
          close: Effect.fn("RuntimeSession.close")(function* () {
            yield* ensureCurrent(notebookUri, token);
            yield* resources.queue.close();
            yield* client
              .executeCommand(closeSessionCommand(notebookUri))
              .pipe(
                Effect.asVoid,
                Effect.ensuring(shutdown(notebookUri, token)),
              );
          }),
          shutdown: () => shutdown(notebookUri, token),
        };
        return {
          token,
          session,
          operations: resources.operations,
          scope,
        } satisfies SessionEntry;
      });

      const getOrCreate = Effect.fn("RuntimeSessions.getOrCreate")(function* (
        notebookUri: NotebookId,
      ) {
        return yield* SynchronizedRef.modifyEffect(
          sessions,
          Effect.fnUntraced(function* (entries) {
            const existing = HashMap.get(entries, notebookUri);
            if (Option.isSome(existing)) {
              return [existing.value.session, entries] as const;
            }

            const entry = yield* makeSession(notebookUri);
            return [
              entry.session,
              HashMap.set(entries, notebookUri, entry),
            ] as const;
          }),
        );
      });

      yield* Effect.forkScoped(
        client.streamOf("marimo/operation").pipe(
          Stream.runForEach(
            Effect.fn("RuntimeSessions.routeOperation")(function* (message) {
              yield* PubSub.publish(allOperations, message);

              const entry = HashMap.get(
                yield* SynchronizedRef.get(sessions),
                message.notebookUri,
              );
              if (Option.isSome(entry)) {
                yield* PubSub.publish(
                  entry.value.operations,
                  message.operation,
                );
              }
            }),
          ),
        ),
      );

      yield* Effect.addFinalizer((exit) =>
        SynchronizedRef.updateEffect(
          sessions,
          Effect.fnUntraced(function* (entries) {
            yield* Effect.forEach(
              HashMap.values(entries),
              (entry) => Scope.close(entry.scope, exit),
              { discard: true },
            );
            return HashMap.empty();
          }),
        ).pipe(Effect.andThen(PubSub.shutdown(allOperations))),
      );

      return {
        getOrCreate,
        operations: () => Stream.fromPubSub(allOperations),
      };
    }),
  },
) {}
