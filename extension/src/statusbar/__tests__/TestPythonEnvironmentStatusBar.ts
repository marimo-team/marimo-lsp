import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";

import * as StatusBar from "../StatusBar.ts";

export interface Interface {
  readonly visible: Effect.Effect<boolean>;
  readonly awaitVisibility: (visible: boolean) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/PythonEnvironmentStatusBar",
) {}

export const layer = Layer.unwrap(
  SubscriptionRef.make(false).pipe(
    Effect.map((visible) =>
      Layer.merge(
        Layer.mock(StatusBar.Service, {
          createStatusBarItem: () =>
            Effect.succeed({
              setText: () => Effect.void,
              setTooltip: () => Effect.void,
              setColor: () => Effect.void,
              setBackgroundColor: () => Effect.void,
              setCommand: () => Effect.void,
              show: SubscriptionRef.set(visible, true),
              hide: SubscriptionRef.set(visible, false),
            }),
        }),
        Layer.succeed(
          Service,
          Service.of({
            visible: SubscriptionRef.get(visible),
            awaitVisibility: (expected) =>
              SubscriptionRef.changes(visible).pipe(
                Stream.filter((current) => current === expected),
                Stream.runHead,
                Effect.asVoid,
              ),
          }),
        ),
      ),
    ),
  ),
);
