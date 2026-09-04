import { Effect, Layer, Option, PubSub, Stream } from "effect";

import * as NotebookRuntime from "../../src/kernel/NotebookRuntime.ts";
import * as MarimoClient from "../../src/lsp/MarimoClient.ts";
import {
  MarimoNotebookDocument,
  type NotebookId,
} from "../../src/schemas/MarimoNotebookDocument.ts";
import * as MarimoClientTest from "./MarimoClient.ts";

const TEST_KERNEL_SESSION_ID = MarimoClientTest.TEST_KERNEL_SESSION_ID;

export interface Options extends MarimoClientTest.Options {
  readonly initialControllers?: ReadonlyArray<NotebookRuntime.NotebookControllerSelection>;
  readonly runtimeSession?: NotebookRuntime.RuntimeSession;
  readonly runtimeSessions?: ReadonlyArray<NotebookRuntime.RuntimeSessionEntry>;
}

/**
 * Provides an in-memory NotebookRuntime that forwards every kernel command to
 * the fake marimo client, plus the client itself and its test controls.
 */
export function layerWith(options: Options = {}) {
  return Layer.unwrap(
    Effect.map(MarimoClientTest.make(options), ({ client, controls }) =>
      Layer.mergeAll(
        Layer.succeed(MarimoClient.Service, client),
        Layer.succeed(MarimoClientTest.Service, controls),
        makeRuntimeLayer(options, client),
      ),
    ),
  );
}

export const layer = layerWith();

function makeRuntimeLayer(options: Options, client: MarimoClient.Interface) {
  return Layer.effect(
    NotebookRuntime.Service,
    Effect.gen(function* () {
      const handles = new Map<NotebookId, NotebookRuntime.NotebookHandle>();
      const controllers = new Map<
        NotebookId,
        NotebookRuntime.NotebookController
      >(
        options.initialControllers?.map(({ notebookUri, controller }) => [
          notebookUri,
          controller,
        ]),
      );
      const selections =
        yield* PubSub.unbounded<NotebookRuntime.NotebookControllerSelection>();
      yield* Effect.addFinalizer(() => PubSub.shutdown(selections));

      const forNotebook = (
        notebookId: NotebookId,
      ): Effect.Effect<NotebookRuntime.NotebookHandle> =>
        Effect.sync(() => {
          const existing = handles.get(notebookId);
          if (existing !== undefined) return existing;
          const handle: NotebookRuntime.NotebookHandle = {
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
                executable: options.runtimeSession?.executable ?? "",
                workingDirectory:
                  options.runtimeSession?.workingDirectory ?? "",
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
      ): Effect.Effect<NotebookRuntime.NotebookDocumentHandle> => {
        const notebookId = MarimoNotebookDocument.from(document).id;
        return Effect.succeed({
          execute: (request, executable) =>
            client
              .execute({
                notebookUri: notebookId,
                executable,
                workingDirectory:
                  options.runtimeSession?.workingDirectory ?? process.cwd(),
                cells: request.cells,
              })
              .pipe(Effect.as(null)),
        });
      };

      const runtime: NotebookRuntime.Interface = {
        executeSessionScratchpad: () => Stream.empty,
        attachController: (notebookId, controller) =>
          Effect.gen(function* () {
            controllers.set(notebookId, controller);
            yield* PubSub.publish(selections, {
              notebookUri: notebookId,
              controller,
            });
          }),
        controllerChanges: Stream.fromPubSub(selections),
        subscribeInputProgress: Effect.succeed(Stream.empty),
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
  );
}
