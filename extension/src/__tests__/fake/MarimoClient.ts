import {
  Context,
  Effect,
  Layer,
  PubSub,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";

import { MarimoLspServer } from "../../config/Config.ts";
import * as MarimoClient from "../../lsp/MarimoClient.ts";
import {
  Command as CommandSchema,
  KernelSessionIdFromString,
} from "../../schemas/Models.gen.ts";
import type {
  DocumentAnalysis,
  KernelNotification,
  MarimoSessionsChanged,
} from "../../types.ts";

export type Command = typeof CommandSchema.Encoded;

export interface Options {
  /**
   * Responds to commands. Every command is recorded before this runs, and
   * `commands` holds the recording so far, ending with `request`.
   */
  readonly send?: (
    request: Command,
    commands: ReadonlyArray<Command>,
  ) => Effect.Effect<unknown, Schema.SchemaError>;
  /** Replaces the kernel notification channel; disables `publishNotification`. */
  readonly kernelNotifications?: Stream.Stream<KernelNotification>;
  /** Replaces the document analysis channel; disables `publishAnalysis`. */
  readonly documentAnalysis?: Stream.Stream<DocumentAnalysis>;
  /** Replaces the session change channel; disables `publishSessionsChanged`. */
  readonly sessionChanges?: Stream.Stream<MarimoSessionsChanged>;
}

/**
 * Test controls for the fake marimo client.
 *
 * The fake records every command the extension sends and lets tests publish
 * server-originated messages. Observe through `commands` and `awaitCommands`
 * instead of adding observation ports to production services.
 */
export interface Interface {
  readonly commands: Effect.Effect<ReadonlyArray<Command>>;
  readonly commandChanges: Stream.Stream<ReadonlyArray<Command>>;
  readonly awaitCommands: (
    predicate: (commands: ReadonlyArray<Command>) => boolean,
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

export const TEST_KERNEL_SESSION_ID = Schema.decodeUnknownSync(
  KernelSessionIdFromString,
)("00000000-0000-4000-8000-000000000001");

/** Provides `MarimoClient.Service` backed by an in-memory fake plus `Service`. */
export function layerWith(options: Options = {}) {
  return Layer.unwrap(
    Effect.map(make(options), ({ client, controls }) =>
      Layer.merge(
        Layer.succeed(MarimoClient.Service, client),
        Layer.succeed(Service, controls),
      ),
    ),
  );
}

/** Builds the fake client and its test controls for one layer build. */
export const make = Effect.fn("MarimoClientTest.make")(function* (
  options: Options,
) {
  const commands = yield* SubscriptionRef.make<ReadonlyArray<Command>>([]);
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
              `MarimoClientTest: cannot publish to ${name} because the test supplied its own stream`,
            ),
          );

  const client: MarimoClient.Interface = {
    server: MarimoLspServer.Python(),
    channel: { name: "marimo-lsp-test", show() {} },
    restart: Effect.void,
    ...MarimoClient.makeCommands({
      send: (request) =>
        SubscriptionRef.modify(commands, (current) => {
          const next = [...current, request];
          return [next, next];
        }).pipe(Effect.flatMap((recorded) => respond(request, recorded))),
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
function defaultResponse(request: Command): Effect.Effect<unknown> {
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

export const layer = layerWith();
