import {
  Cause,
  Data,
  Deferred,
  Effect,
  Exit,
  Option,
  Ref,
  Scope,
} from "effect";

/**
 * Raised when work is submitted after its runtime session has been closed.
 */
export class RuntimeCommandQueueClosedError extends Data.TaggedError(
  "RuntimeCommandQueueClosedError",
)<{}> {}

/**
 * State that may replace an adjacent pending update of the same kind.
 *
 * The queue never merges the command currently being sent, nor does it merge
 * across another kind or an ordered command.
 */
export interface StateUpdate<Command> {
  readonly kind: string;
  readonly command: Command;
  readonly merge: (older: Command, newer: Command) => Command;
}

type QueueItem<Command, Error> = Data.TaggedEnum<{
  Replaceable: StateUpdate<Command>;
  Ordered: {
    readonly command: Command;
    readonly sent: Deferred.Deferred<
      void,
      Error | RuntimeCommandQueueClosedError
    >;
  };
}>;

type QueueState<Command, Error> = Data.TaggedEnum<{
  Idle: {};
  Active: {
    readonly inFlight: QueueItem<Command, Error>;
    readonly pending: ReadonlyArray<QueueItem<Command, Error>>;
  };
  Closed: {};
}>;

const stateItem = <Command, Error>(
  update: StateUpdate<Command>,
): QueueItem<Command, Error> => ({
  _tag: "Replaceable",
  ...update,
});

const orderedItem = <Command, Error>(
  command: Command,
  sent: Deferred.Deferred<void, Error | RuntimeCommandQueueClosedError>,
): QueueItem<Command, Error> => ({
  _tag: "Ordered",
  command,
  sent,
});

/**
 * The outbound command queue for one live marimo runtime session.
 *
 * ```ts
 * interface RuntimeCommandQueue<Command> {
 *   enqueueState(update): Effect<void>
 *   send(command): Effect<void>
 *   close(): Effect<void>
 * }
 * ```
 *
 * Only one command is sent at a time. `send` preserves every command and waits
 * for that send to finish. `enqueueState` returns once the update is queued;
 * adjacent pending updates of the same kind may be merged before they are sent.
 *
 * Closing the queue rejects new work, fails callers waiting in `send`, and
 * interrupts the active send.
 */
export interface RuntimeCommandQueue<Command, Error, Requirements = never> {
  /**
   * Queue state without waiting for it to be sent. A later pending update of
   * the same kind may replace it.
   */
  readonly enqueueState: (
    update: StateUpdate<Command>,
  ) => Effect.Effect<void, RuntimeCommandQueueClosedError, Requirements>;

  /**
   * Queue a command without merging it, and wait for the send to finish.
   */
  readonly send: (
    command: Command,
  ) => Effect.Effect<
    void,
    Error | RuntimeCommandQueueClosedError,
    Requirements
  >;

  /**
   * Reject new work, fail waiting callers, and interrupt the active send.
   */
  readonly close: () => Effect.Effect<void>;
}

interface EnqueueResult<Command, Error> {
  readonly start: Option.Option<QueueItem<Command, Error>>;
  readonly accepted: boolean;
}

function mergePending<Command, Error>(
  pending: ReadonlyArray<QueueItem<Command, Error>>,
  incoming: QueueItem<Command, Error>,
): ReadonlyArray<QueueItem<Command, Error>> {
  if (incoming._tag !== "Replaceable") {
    return [...pending, incoming];
  }

  const previous = pending.at(-1);
  if (previous?._tag !== "Replaceable" || previous.kind !== incoming.kind) {
    return [...pending, incoming];
  }

  return [
    ...pending.slice(0, -1),
    stateItem<Command, Error>({
      ...incoming,
      command: incoming.merge(previous.command, incoming.command),
    }),
  ];
}

/**
 * Creates the outbound command queue for one runtime session.
 */
export const makeRuntimeCommandQueue = Effect.fn("RuntimeCommandQueue.make")(
  function* <Command, Error, Requirements>(
    sendCommand: (command: Command) => Effect.Effect<void, Error, Requirements>,
  ) {
    const State = Data.taggedEnum<QueueState<Command, Error>>();
    const state = yield* Ref.make<QueueState<Command, Error>>(State.Idle());
    const sendScope = yield* Scope.make();

    const enqueue = Effect.fn("RuntimeCommandQueue.enqueue")(function* (
      item: QueueItem<Command, Error>,
    ) {
      return yield* Ref.modify(
        state,
        (
          current,
        ): readonly [
          EnqueueResult<Command, Error>,
          QueueState<Command, Error>,
        ] => {
          return State.$match(current, {
            Closed: () =>
              [{ start: Option.none(), accepted: false }, current] as const,
            Idle: () =>
              [
                { start: Option.some(item), accepted: true },
                State.Active({ inFlight: item, pending: [] }),
              ] as const,
            Active: (active) =>
              [
                { start: Option.none(), accepted: true },
                State.Active({
                  ...active,
                  pending: mergePending(active.pending, item),
                }),
              ] as const,
          });
        },
      );
    });

    const next = Effect.fn("RuntimeCommandQueue.next")(function* () {
      return yield* Ref.modify(
        state,
        (
          current,
        ): readonly [
          Option.Option<QueueItem<Command, Error>>,
          QueueState<Command, Error>,
        ] => {
          return State.$match(current, {
            Idle: () => [Option.none(), current] as const,
            Closed: () => [Option.none(), current] as const,
            Active: ({ pending }) => {
              const [next, ...remaining] = pending;
              if (next === undefined) {
                return [Option.none(), State.Idle()] as const;
              }
              return [
                Option.some(next),
                State.Active({ inFlight: next, pending: remaining }),
              ] as const;
            },
          });
        },
      );
    });

    const drain = Effect.fn("RuntimeCommandQueue.drain")(function* (
      initial: QueueItem<Command, Error>,
    ) {
      let current = initial;
      while (true) {
        const exit = yield* Effect.exit(sendCommand(current.command));

        if (current._tag === "Ordered") {
          yield* Deferred.done(current.sent, exit);
        } else if (
          Exit.isFailure(exit) &&
          !Cause.isInterruptedOnly(exit.cause)
        ) {
          yield* Effect.logWarning("Failed to send queued runtime state").pipe(
            Effect.annotateLogs({
              cause: exit.cause,
              kind: current.kind,
            }),
          );
        }

        const following = yield* next();
        if (Option.isNone(following)) return;
        current = following.value;
      }
    });

    const startDrain = Effect.fn("RuntimeCommandQueue.startDrain")(function* (
      item: QueueItem<Command, Error>,
    ) {
      yield* Effect.forkIn(drain(item), sendScope);
    });

    const enqueueState = Effect.fn("RuntimeCommandQueue.enqueueState")(
      function* (update: StateUpdate<Command>) {
        const item: QueueItem<Command, Error> = stateItem<Command, Error>(
          update,
        );
        const result = yield* enqueue(item);
        if (!result.accepted) {
          yield* new RuntimeCommandQueueClosedError();
        }
        if (Option.isSome(result.start)) {
          yield* startDrain(result.start.value);
        }
        return;
      },
    );

    const send = Effect.fn("RuntimeCommandQueue.send")(function* (
      command: Command,
    ) {
      const sent = yield* Deferred.make<
        void,
        Error | RuntimeCommandQueueClosedError
      >();
      const item = orderedItem<Command, Error>(command, sent);
      const result = yield* enqueue(item);
      if (!result.accepted) {
        yield* new RuntimeCommandQueueClosedError();
      }
      if (Option.isSome(result.start)) {
        yield* startDrain(result.start.value);
      }
      return yield* Deferred.await(sent);
    });

    const close = Effect.fn("RuntimeCommandQueue.close")(function* () {
      const abandoned = yield* Ref.modify(
        state,
        (
          current,
        ): readonly [
          ReadonlyArray<QueueItem<Command, Error>>,
          QueueState<Command, Error>,
        ] => {
          return State.$match(current, {
            Idle: () => [[], State.Closed()] as const,
            Closed: () => [[], State.Closed()] as const,
            Active: ({ inFlight, pending }) =>
              [[inFlight, ...pending], State.Closed()] as const,
          });
        },
      );

      yield* Effect.forEach(
        abandoned,
        (item) =>
          item._tag === "Ordered"
            ? Deferred.fail(item.sent, new RuntimeCommandQueueClosedError())
            : Effect.void,
        { discard: true },
      );
      yield* Scope.close(sendScope, Exit.void);
    });

    yield* Effect.addFinalizer(() => close());

    return {
      enqueueState,
      send,
      close,
    };
  },
);
