import { Context, Effect, Layer, Logger, Ref } from "effect";

import * as Telemetry from "../../src/telemetry/Telemetry.ts";

/** Observations of telemetry the extension reported. */
export interface Interface {
  readonly tySetupActions: Effect.Effect<
    ReadonlyArray<Telemetry.TySetupAction>
  >;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/Telemetry",
) {}

/** Telemetry that records ty setup actions and drops everything else. */
export const layer = Layer.unwrap(
  Effect.map(
    Ref.make<ReadonlyArray<Telemetry.TySetupAction>>([]),
    (tySetupActions) =>
      Layer.merge(
        Layer.succeed(Telemetry.Service, {
          tySetup: (action) =>
            Ref.update(tySetupActions, (current) => [...current, action]),
          commandExecuted: () => Effect.void,
          notebookCreated: Effect.void,
          notebookOpened: () => Effect.void,
          tutorialOpened: () => Effect.void,
          uvMissing: () => Effect.void,
          uvInstallClicked: Effect.void,
          binaryResolved: () => Effect.void,
          binaryUnresolved: () => Effect.void,
          lspModeSelected: () => Effect.void,
          lspStarted: () => Effect.void,
          errorLogger: Logger.make(() => undefined),
        }),
        Layer.succeed(Service, { tySetupActions: Ref.get(tySetupActions) }),
      ),
  ),
);
