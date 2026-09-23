import { Context, Effect, Layer, Scope } from "effect";
// oxlint-disable-next-line marimo/vscode-type-only
import * as vscode from "vscode";

import { acquireDisposable } from "../lib/acquireDisposable.ts";

export interface Interface {
  readonly appName: string;
  readonly appRoot: string;
  readonly appHost: string;
  readonly machineId: string;
  readonly createTelemetryLogger: (
    sender: vscode.TelemetrySender,
    options?: vscode.TelemetryLoggerOptions,
  ) => Effect.Effect<vscode.TelemetryLogger, never, Scope.Scope>;
  readonly openExternal: (target: vscode.Uri) => Effect.Effect<boolean>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/Env",
) {}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const api = vscode.env;

    const createTelemetryLogger = Effect.fn("Env.createTelemetryLogger")(
      function* (
        sender: vscode.TelemetrySender,
        options?: vscode.TelemetryLoggerOptions,
      ) {
        return yield* acquireDisposable(() =>
          api.createTelemetryLogger(sender, options),
        );
      },
    );

    const openExternal = Effect.fn("Env.openExternal")(function* (
      target: vscode.Uri,
    ) {
      return yield* Effect.promise(() => api.openExternal(target));
    });

    return Service.of({
      appName: api.appName,
      appRoot: api.appRoot,
      appHost: api.appHost,
      machineId: api.machineId,
      createTelemetryLogger,
      openExternal,
    });
  }),
);
