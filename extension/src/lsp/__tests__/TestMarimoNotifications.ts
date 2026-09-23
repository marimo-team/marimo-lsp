import { Context, Effect, Layer, Option, Queue, Stream } from "effect";

import type { DocumentAnalysis, KernelNotification } from "../../types.ts";
import * as MarimoClient from "../MarimoClient.ts";

export interface Snapshot {
  readonly commandNotificationsRequested: boolean;
  readonly kernelRegistrations: number;
  readonly documentRegistrations: number;
}

export interface Interface {
  readonly drainCommandNotifications: Effect.Effect<void>;
  readonly takeKernel: Effect.Effect<Option.Option<KernelNotification>>;
  readonly takeDocumentAnalysis: Effect.Effect<Option.Option<DocumentAnalysis>>;
  readonly awaitKernelSubscriptions: (count: number) => Effect.Effect<void>;
  readonly awaitDocumentSubscriptions: (count: number) => Effect.Effect<void>;
  readonly publishKernel: (message: unknown) => Effect.Effect<void>;
  readonly publishDocumentAnalysis: (message: unknown) => Effect.Effect<void>;
  readonly snapshot: Effect.Effect<Snapshot>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/MarimoNotifications",
) {}

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    let commandNotificationsRequested = false;
    let kernelRegistrations = 0;
    let documentRegistrations = 0;
    let kernelHandler: ((message: unknown) => void) | undefined;
    let documentHandler: ((message: unknown) => void) | undefined;
    const kernelSubscriptions = yield* Queue.unbounded<void>();
    const documentSubscriptions = yield* Queue.unbounded<void>();

    const kernelNotifications =
      yield* MarimoClient.makeKernelNotificationStream((handler) => {
        kernelRegistrations += 1;
        kernelHandler = handler;
        return { dispose() {} };
      });
    const documentAnalyses = yield* MarimoClient.makeDocumentAnalysisStream(
      (handler) => {
        documentRegistrations += 1;
        documentHandler = handler;
        return { dispose() {} };
      },
    );
    const commands = MarimoClient.makeCommands({
      send: () => Effect.void,
      kernelNotifications: Stream.suspend(() => {
        commandNotificationsRequested = true;
        return Stream.empty;
      }),
    });

    const awaitSubscriptions = (
      subscriptions: Queue.Queue<void>,
      count: number,
    ) =>
      Effect.forEach(
        Array.from({ length: count }),
        () => Queue.take(subscriptions),
        { discard: true },
      );
    const take = <A>(
      stream: Stream.Stream<A>,
      subscriptions: Queue.Queue<void>,
    ) =>
      Queue.offer(subscriptions, undefined).pipe(
        Effect.andThen(stream.pipe(Stream.take(1), Stream.runHead)),
      );

    return Layer.succeed(Service, {
      drainCommandNotifications: commands.kernelNotifications.pipe(
        Stream.runDrain,
      ),
      takeKernel: take(kernelNotifications, kernelSubscriptions),
      takeDocumentAnalysis: take(documentAnalyses, documentSubscriptions),
      awaitKernelSubscriptions: (count) =>
        awaitSubscriptions(kernelSubscriptions, count),
      awaitDocumentSubscriptions: (count) =>
        awaitSubscriptions(documentSubscriptions, count),
      publishKernel: (message) =>
        Effect.sync(() => {
          if (kernelHandler === undefined) {
            throw new Error("Kernel notification handler is not registered");
          }
          kernelHandler(message);
        }),
      publishDocumentAnalysis: (message) =>
        Effect.sync(() => {
          if (documentHandler === undefined) {
            throw new Error("Document analysis handler is not registered");
          }
          documentHandler(message);
        }),
      snapshot: Effect.sync(() => ({
        commandNotificationsRequested,
        kernelRegistrations,
        documentRegistrations,
      })),
    });
  }),
);
