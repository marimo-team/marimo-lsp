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
import {
  Command,
  KernelSessionIdFromString,
} from "../../schemas/Models.gen.ts";
import type {
  DocumentAnalysis,
  KernelNotification,
  MarimoSessionsChanged,
} from "../../types.ts";

export type TestCommand = typeof Command.Encoded;

interface Options {
  readonly send?: (
    request: TestCommand,
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
              updateUIElements: (fields) =>
                client.updateUiElement({
                  ...fields,
                  notebookUri: notebookId,
                  kernelSessionId: TEST_KERNEL_SESSION_ID,
                }),
              updateModel: (fields) =>
                client.setModelValue({
                  ...fields,
                  notebookUri: notebookId,
                  kernelSessionId: TEST_KERNEL_SESSION_ID,
                }),
              invokeFunction: (fields) =>
                client.invokeFunction({
                  ...fields,
                  notebookUri: notebookId,
                  kernelSessionId: TEST_KERNEL_SESSION_ID,
                }),
              deleteCell: (fields) =>
                client.deleteCell({
                  ...fields,
                  notebookUri: notebookId,
                  kernelSessionId: TEST_KERNEL_SESSION_ID,
                }),
              interrupt: client.interrupt({
                notebookUri: notebookId,
                kernelSessionId: TEST_KERNEL_SESSION_ID,
              }),
              restart: client
                .restartSession({
                  notebookUri: notebookId,
                  executable: "",
                  workingDirectory: "",
                })
                .pipe(Effect.as(undefined)),
              close: client
                .closeSession({ notebookUri: notebookId })
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
            execute: (request, executable) =>
              client.execute({
                notebookUri: notebookId,
                executable,
                workingDirectory:
                  options.runtimeSession?.workingDirectory ?? process.cwd(),
                cells: request.cells,
              }),
          });
        };

        const runtime: Context.Service.Shape<typeof NotebookRuntime> = {
          attachController: (notebookId, controller) =>
            Effect.gen(function* () {
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
                newNotebookUri: newNotebookId,
              })
              .pipe(Effect.asVoid),
          restoreSession: (notebookId, executable, workingDirectory) =>
            client
              .restartSession({
                notebookUri: notebookId,
                executable,
                workingDirectory,
                createIfMissing: true,
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
      send:
        options.send ??
        ((request) =>
          Effect.succeed(
            request.kind === "list-sessions"
              ? { sessions: [] }
              : request.kind === "read-notebook-outputs"
                ? { cells: [] }
                : null,
          )),
      kernelNotifications: options.kernelNotifications ?? Stream.never,
      documentAnalysis: options.documentAnalysis ?? Stream.never,
      sessionChanges: options.sessionChanges ?? Stream.never,
    }),
  };
}
