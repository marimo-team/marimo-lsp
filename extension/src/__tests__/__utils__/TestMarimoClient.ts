import {
  Context,
  Effect,
  Layer,
  Option,
  PubSub,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";

import { MarimoLspServer } from "../../config/Config.ts";
import * as NotebookRuntime from "../../kernel/NotebookRuntime.ts";
import * as MarimoClient from "../../lsp/MarimoClient.ts";
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

export interface Options {
  /** Responds to commands. Every command is recorded before this runs. */
  readonly send?: (
    request: TestCommand,
  ) => Effect.Effect<unknown, Schema.SchemaError>;
  /** Replaces the kernel notification channel; disables `publishNotification`. */
  readonly kernelNotifications?: Stream.Stream<KernelNotification>;
  /** Replaces the document analysis channel; disables `publishAnalysis`. */
  readonly documentAnalysis?: Stream.Stream<DocumentAnalysis>;
  /** Replaces the session change channel; disables `publishSessionsChanged`. */
  readonly sessionChanges?: Stream.Stream<MarimoSessionsChanged>;
  readonly initialControllers?: ReadonlyArray<NotebookRuntime.NotebookControllerSelection>;
  readonly runtimeSession?: NotebookRuntime.RuntimeSession;
  readonly runtimeSessions?: ReadonlyArray<NotebookRuntime.RuntimeSessionEntry>;
}

/**
 * Test controls for the fake marimo client.
 *
 * The fake records every command the extension sends and lets tests publish
 * server-originated messages. Observe through `commands` and `awaitCommands`
 * instead of adding observation ports to production services.
 */
export interface Interface {
  readonly commands: Effect.Effect<ReadonlyArray<TestCommand>>;
  readonly commandChanges: Stream.Stream<ReadonlyArray<TestCommand>>;
  readonly awaitCommands: (
    predicate: (commands: ReadonlyArray<TestCommand>) => boolean,
  ) => Effect.Effect<void>;
  readonly publishNotification: (
    notification: KernelNotification,
  ) => Effect.Effect<boolean>;
  readonly publishAnalysis: (
    analysis: DocumentAnalysis,
  ) => Effect.Effect<boolean>;
  readonly publishSessionsChanged: (
    change: MarimoSessionsChanged,
  ) => Effect.Effect<boolean>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/MarimoClient",
) {}

const TEST_KERNEL_SESSION_ID = Schema.decodeUnknownSync(
  KernelSessionIdFromString,
)("00000000-0000-4000-8000-000000000001");

/** Provides `MarimoClient.Service` backed by an in-memory fake plus `Service`. */
export function makeTestMarimoClient(options: Options = {}) {
  return Layer.unwrap(
    Effect.map(makeClient(options), ({ client, controls }) =>
      Layer.merge(
        Layer.succeed(MarimoClient.Service, client),
        Layer.succeed(Service, controls),
      ),
    ),
  );
}

export function makeTestNotebookRuntime(options: Options = {}) {
  return Layer.unwrap(
    Effect.map(makeClient(options), ({ client, controls }) =>
      Layer.mergeAll(
        Layer.succeed(MarimoClient.Service, client),
        Layer.succeed(Service, controls),
        makeRuntimeLayer(options, client),
      ),
    ),
  );
}

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

const makeClient = Effect.fn("TestMarimoClient.make")(function* (
  options: Options,
) {
  const commands = yield* SubscriptionRef.make<ReadonlyArray<TestCommand>>([]);
  const kernelNotifications = yield* PubSub.unbounded<KernelNotification>();
  const documentAnalysis = yield* PubSub.unbounded<DocumentAnalysis>();
  const sessionChanges = yield* PubSub.unbounded<MarimoSessionsChanged>();
  yield* Effect.addFinalizer(() =>
    Effect.all(
      [
        PubSub.shutdown(kernelNotifications),
        PubSub.shutdown(documentAnalysis),
        PubSub.shutdown(sessionChanges),
      ],
      { discard: true },
    ),
  );
  const respond = options.send ?? defaultResponse;
  // Overrides replace the channel rather than merging with it: a merged stream
  // subscribes asynchronously and would lose messages published right after
  // a consumer starts.
  const channel = <A>(
    pubsub: PubSub.PubSub<A>,
    override: Stream.Stream<A> | undefined,
  ): Stream.Stream<A> => override ?? Stream.fromPubSub(pubsub);
  const publish =
    <A>(name: string, pubsub: PubSub.PubSub<A>, override: unknown) =>
    (message: A) =>
      override === undefined
        ? PubSub.publish(pubsub, message)
        : Effect.die(
            new Error(
              `TestMarimoClient: cannot publish to ${name} because the test supplied its own stream`,
            ),
          );

  const client: MarimoClient.Interface = {
    server: MarimoLspServer.Python(),
    channel: { name: "marimo-lsp-test", show() {} },
    restart: Effect.void,
    ...MarimoClient.makeCommands({
      send: (request) =>
        SubscriptionRef.update(commands, (current) => [
          ...current,
          request,
        ]).pipe(Effect.andThen(() => respond(request))),
      kernelNotifications: channel(
        kernelNotifications,
        options.kernelNotifications,
      ),
      documentAnalysis: channel(documentAnalysis, options.documentAnalysis),
      sessionChanges: channel(sessionChanges, options.sessionChanges),
    }),
  };

  const controls = Service.of({
    commands: SubscriptionRef.get(commands),
    commandChanges: SubscriptionRef.changes(commands),
    awaitCommands: (predicate) =>
      SubscriptionRef.changes(commands).pipe(
        Stream.filter(predicate),
        Stream.runHead,
        Effect.asVoid,
      ),
    publishNotification: publish(
      "kernelNotifications",
      kernelNotifications,
      options.kernelNotifications,
    ),
    publishAnalysis: publish(
      "documentAnalysis",
      documentAnalysis,
      options.documentAnalysis,
    ),
    publishSessionsChanged: publish(
      "sessionChanges",
      sessionChanges,
      options.sessionChanges,
    ),
  });

  return { client, controls };
});

/** Canned responses that satisfy every command's response schema. */
function defaultResponse(request: TestCommand): Effect.Effect<unknown> {
  switch (request.kind) {
    case "list-sessions":
      return Effect.succeed({ generation: 1, revision: 1, sessions: [] });
    case "read-notebook-outputs":
      return Effect.succeed({ cells: [] });
    case "set-display-theme":
      return Effect.succeed({ success: true });
    case "execute":
      return Effect.succeed({
        generation: 1,
        revision: 2,
        sessions: [
          {
            sessionId: TEST_KERNEL_SESSION_ID,
            notebookUri: request.notebookUri,
            filename: null,
            executable: request.executable,
            workingDirectory: request.workingDirectory,
            startedAt: 1,
            status: "running",
            attached: true,
          },
        ],
      });
    case "close-session":
    case "restart-session":
    case "move-session":
    case "shutdown-all-sessions":
      return Effect.succeed({ generation: 1, revision: 3, sessions: [] });
    default:
      return Effect.succeed(null);
  }
}

export const layer = makeTestMarimoClient();
