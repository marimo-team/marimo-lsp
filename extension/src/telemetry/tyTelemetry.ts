import { Effect, Option, Schema } from "effect";

import type { BinarySource } from "../lib/binaryResolution.ts";
import type { LspFeature } from "../lsp/client.ts";
import { createStorageKey, type Storage } from "../platform/Storage.ts";

export type TyAvailability =
  | { readonly state: "starting" | "missing" | "failed" | "disabled" }
  | {
      readonly state: "ready";
      readonly source: BinarySource["_tag"];
      readonly version: string;
    };

export type TyFeature = LspFeature;
export type TyPromptAction =
  | "shown"
  | "install"
  | "update"
  | "dismiss"
  | "dont_show_again"
  | "suppressed";

interface InstallAttempt {
  readonly attempt_id: string;
  readonly install_activation_id: string;
}

export type TyTelemetryEvent =
  | ({ readonly event: "ty_status" } & TyAvailability)
  | {
      readonly event: "ty_prompt";
      readonly action: TyPromptAction;
      readonly extension_installed: boolean;
    }
  | ({ readonly event: "ty_install_started" } & InstallAttempt)
  | ({
      readonly event: "ty_install_finished";
      readonly outcome: "succeeded" | "failed";
    } & InstallAttempt)
  | ({
      readonly event: "ty_install_activation_result";
      readonly outcome: "ready" | "missing" | "failed" | "disabled";
    } & InstallAttempt)
  | { readonly event: "ty_feature_used"; readonly feature: TyFeature };

export interface TyTelemetry {
  readonly stateChanged: (state: TyAvailability) => Effect.Effect<void>;
  readonly prompt: (
    action: TyPromptAction,
    extensionInstalled: boolean,
  ) => Effect.Effect<void>;
  readonly installStarted: Effect.Effect<void>;
  readonly installFinished: (
    outcome: "succeeded" | "failed",
  ) => Effect.Effect<void>;
  readonly featureUsed: (feature: TyFeature) => Effect.Effect<void>;
}

export const noopTyTelemetry: TyTelemetry = {
  stateChanged: () => Effect.void,
  prompt: () => Effect.void,
  installStarted: Effect.void,
  installFinished: () => Effect.void,
  featureUsed: () => Effect.void,
};

const pendingInstallKey = createStorageKey(
  "telemetry.ty.pendingInstall",
  Schema.Struct({
    attempt_id: Schema.String,
    install_activation_id: Schema.String,
  }),
);

/** Tracks one activation; the pending install alone survives a window reload. */
export const makeTyTelemetry = Effect.fn("makeTyTelemetry")(
  function* (options: {
    readonly activationId: string;
    readonly storage: typeof Storage.Service;
    readonly enabled: () => boolean;
    readonly emit: (event: TyTelemetryEvent) => Effect.Effect<void>;
  }) {
    let pending = options.enabled()
      ? Option.getOrUndefined(
          yield* options.storage.workspace
            .get(pendingInstallKey)
            .pipe(Effect.orElseSucceed(() => Option.none())),
        )
      : undefined;
    const usedFeatures = new Set<TyFeature>();

    const telemetry: TyTelemetry = {
      stateChanged: Effect.fn("TyTelemetry.stateChanged")(function* (
        state: TyAvailability,
      ) {
        if (!options.enabled()) return;
        yield* options.emit({ event: "ty_status", ...state });
        if (
          state.state !== "starting" &&
          pending !== undefined &&
          pending.install_activation_id !== options.activationId
        ) {
          yield* options.emit({
            event: "ty_install_activation_result",
            outcome: state.state,
            ...pending,
          });
          pending = undefined;
          yield* options.storage.workspace
            .delete(pendingInstallKey)
            .pipe(Effect.ignore);
        }
      }),
      prompt: (action, extensionInstalled) =>
        Effect.suspend(() =>
          options.enabled()
            ? options.emit({
                event: "ty_prompt",
                action,
                extension_installed: extensionInstalled,
              })
            : Effect.void,
        ),
      installStarted: Effect.gen(function* () {
        if (!options.enabled()) return;
        pending = {
          attempt_id: crypto.randomUUID(),
          install_activation_id: options.activationId,
        };
        yield* options.storage.workspace
          .set(pendingInstallKey, pending)
          .pipe(Effect.ignore);
        yield* options.emit({ event: "ty_install_started", ...pending });
      }),
      installFinished: Effect.fn("TyTelemetry.installFinished")(function* (
        outcome: "succeeded" | "failed",
      ) {
        if (!options.enabled() || pending === undefined) return;
        yield* options.emit({
          event: "ty_install_finished",
          outcome,
          ...pending,
        });
        if (outcome === "failed") {
          pending = undefined;
          yield* options.storage.workspace
            .delete(pendingInstallKey)
            .pipe(Effect.ignore);
        }
      }),
      featureUsed: (feature) =>
        Effect.suspend(() => {
          if (!options.enabled() || usedFeatures.has(feature))
            return Effect.void;
          usedFeatures.add(feature);
          return options.emit({ event: "ty_feature_used", feature });
        }),
    };
    return telemetry;
  },
);
