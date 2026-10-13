import { Context, Effect, Layer, Logger, Ref } from "effect";

import * as Telemetry from "../../src/telemetry/Telemetry.ts";

/** Observations of telemetry the extension reported. */
export interface Interface {
  readonly tySetupActions: Effect.Effect<
    ReadonlyArray<Telemetry.TySetupAction>
  >;
  /** Servers whose binary lookup came up empty, in order. */
  readonly unresolvedBinaries: Effect.Effect<ReadonlyArray<"ruff" | "ty">>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/Telemetry",
) {}

/** Telemetry that records ty setup and binary lookups and drops the rest. */
export const layer = Layer.unwrap(
  Effect.map(
    Effect.all([
      Ref.make<ReadonlyArray<Telemetry.TySetupAction>>([]),
      Ref.make<ReadonlyArray<"ruff" | "ty">>([]),
    ]),
    ([tySetupActions, unresolvedBinaries]) =>
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
          binaryUnresolved: (server) =>
            Ref.update(unresolvedBinaries, (current) => [...current, server]),
          lspModeSelected: () => Effect.void,
          lspStarted: () => Effect.void,
          errorLogger: Logger.make(() => undefined),
        }),
        Layer.succeed(Service, {
          tySetupActions: Ref.get(tySetupActions),
          unresolvedBinaries: Ref.get(unresolvedBinaries),
        }),
      ),
  ),
);
