import {
  type Context,
  Effect,
  Layer,
  Option,
  PubSub,
  Schema,
  Stream,
} from "effect";

import { MarimoLspServer } from "../../config/Config.ts";
import {
  type NotebookController,
  type NotebookControllerSelection,
  type NotebookDocumentHandle,
  type NotebookHandle,
  NotebookRuntime,
  type RuntimeSession,
  type RuntimeSessionEntry,
} from "../../kernel/NotebookRuntime.ts";
import { makeMarimoCommands, MarimoClient } from "../../lsp/MarimoClient.ts";
import {
  MarimoNotebookDocument,
  type NotebookId,
} from "../../schemas/MarimoNotebookDocument.ts";
import { KernelSessionIdFromString } from "../../schemas/Models.gen.ts";
import type {
  DocumentAnalysis,
  KernelNotification,
  MarimoApiCall,
  MarimoSessionsChanged,
} from "../../types.ts";

interface Options {
  readonly execute?: (
    request: MarimoApiCall,
  ) => Effect.Effect<unknown, Schema.SchemaError>;
  readonly kernelNotifications?: Stream.Stream<KernelNotification>;
  readonly documentAnalysis?: Stream.Stream<DocumentAnalysis>;
  readonly sessionChanges?: Stream.Stream<MarimoSessionsChanged>;
  readonly initialControllers?: ReadonlyArray<NotebookControllerSelection>;
  readonly runtimeSession?: RuntimeSession;
  readonly runtimeSessions?: ReadonlyArray<RuntimeSessionEntry>;
}

const TEST_KERNEL_SESSION_ID = Schema.decodeUnknownSync(
  KernelSessionIdFromString,
)("00000000-0000-4000-8000-000000000001");

export function makeTestMarimoClient(options: Options = {}) {
  return Layer.succeed(MarimoClient, makeTestMarimoClientValue(options));
}

export function makeTestNotebookRuntime(options: Options = {}) {
  const client = makeTestMarimoClientValue(options);
  return Layer.merge(
    Layer.succeed(MarimoClient, client),
    Layer.effect(
      NotebookRuntime,
      Effect.gen(function* () {
        const handles = new Map<NotebookId, NotebookHandle>();
        const controllers = new Map<NotebookId, NotebookController>(
          options.initialControllers?.map(({ notebookUri, controller }) => [
            notebookUri,
            controller,
          ]),
        );
        const selections =
          yield* PubSub.unbounded<NotebookControllerSelection>();
        yield* Effect.addFinalizer(() => PubSub.shutdown(selections));

        const forNotebook = (
          notebookId: NotebookId,
        ): Effect.Effect<NotebookHandle> =>
          Effect.sync(() => {
            const existing = handles.get(notebookId);
            if (existing !== undefined) return existing;
            const handle: NotebookHandle = {
              id: notebookId,
              getController: Effect.sync(() =>
                Option.fromNullishOr(controllers.get(notebookId)),
              ),
              executeScratchpad: () => Stream.empty,
              updateUIElements: (inner) =>
                client.updateUiElement({
                  notebookUri: notebookId,
                  sessionId: TEST_KERNEL_SESSION_ID,
                  inner,
                }),
              updateModel: (inner) =>
                client.setModelValue({
                  notebookUri: notebookId,
                  sessionId: TEST_KERNEL_SESSION_ID,
                  inner,
                }),
              invokeFunction: (inner) =>
                client.invokeFunction({
                  notebookUri: notebookId,
                  sessionId: TEST_KERNEL_SESSION_ID,
                  inner,
                }),
              deleteCell: (inner) =>
                client.deleteCell({
                  notebookUri: notebookId,
                  sessionId: TEST_KERNEL_SESSION_ID,
                  inner,
                }),
              interrupt: client.interrupt({
                notebookUri: notebookId,
                inner: { sessionId: TEST_KERNEL_SESSION_ID },
              }),
              restart: client
                .restartSession({
                  notebookUri: notebookId,
                  inner: { executable: "", workingDirectory: "" },
                })
                .pipe(Effect.as(undefined)),
              close: client
                .closeSession({ notebookUri: notebookId, inner: {} })
                .pipe(Effect.asVoid),
            };
            handles.set(notebookId, handle);
            return handle;
          });

        const forDocument = (
          document: Parameters<typeof MarimoNotebookDocument.from>[0],
        ): Effect.Effect<NotebookDocumentHandle> => {
          const notebookId = MarimoNotebookDocument.from(document).id;
          return Effect.succeed({
            executeCells: (inner, executable) =>
              client.executeCells({
                notebookUri: notebookId,
                executable,
                workingDirectory:
                  options.runtimeSession?.workingDirectory ?? process.cwd(),
                inner,
              }),
          });
        };

        const runtime: Context.Service.Shape<typeof NotebookRuntime> = {
          attachController: (document, controller) =>
            Effect.gen(function* () {
              const notebookId = MarimoNotebookDocument.from(document).id;
              controllers.set(notebookId, controller);
              yield* PubSub.publish(selections, {
                notebookUri: notebookId,
                controller,
              });
            }),
          controllerChanges: Stream.fromPubSub(selections),
          getRuntimeSession: () =>
            Effect.succeed(Option.fromNullishOr(options.runtimeSession)),
          getRuntimeSessions: Effect.succeed([
            ...(options.runtimeSessions ?? []),
          ]),
          activeRuntimeSession: Effect.succeed(
            Option.fromNullishOr(options.runtimeSession),
          ),
          moveSession: (notebookId, newNotebookId) =>
            client
              .moveSession({
                notebookUri: notebookId,
                inner: { newNotebookUri: newNotebookId },
              })
              .pipe(Effect.asVoid),
          restoreSession: (notebookId, executable, workingDirectory) =>
            client
              .restartSession({
                notebookUri: notebookId,
                inner: {
                  executable,
                  workingDirectory,
                  createIfMissing: true,
                },
              })
              .pipe(Effect.asVoid),
          shutdownAll: client.shutdownAllSessions({}).pipe(Effect.asVoid),
          forDocument,
          forNotebook,
        };
        return runtime;
      }),
    ),
  );
}

function makeTestMarimoClientValue(
  options: Options,
): Context.Service.Shape<typeof MarimoClient> {
  return {
    server: MarimoLspServer.Python(),
    channel: { name: "marimo-lsp-test", show() {} },
    restart: Effect.void,
    ...makeMarimoCommands({
      execute:
        options.execute ??
        ((request) =>
          Effect.succeed(
            request.method === "list-sessions" ? { sessions: [] } : null,
          )),
      kernelNotifications: options.kernelNotifications ?? Stream.never,
      documentAnalysis: options.documentAnalysis ?? Stream.never,
      sessionChanges: options.sessionChanges ?? Stream.never,
    }),
  };
}
