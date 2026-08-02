import { Effect, Layer, Option, Stream } from "effect";

import { VsCode } from "../platform/VsCode.ts";
import { MarimoConfigurationService } from "./MarimoConfigurationService.ts";

/**
 * Mirrors kernel configuration into VS Code context keys for UI:
 * - "marimo.config.runtime.on_cell_change" - Current on_cell_change mode ("autorun" | "lazy")
 * - "marimo.config.runtime.auto_reload" - Current auto_reload mode ("off" | "lazy" | "autorun")
 *
 * Pure side effect: nothing consumes this as a service.
 */
export const ConfigContextManagerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const configService = yield* MarimoConfigurationService;

    // Update on_cell_change context based on current state
    yield* Effect.forkScoped(
      configService
        .streamOf((config) => config.runtime?.on_cell_change)
        .pipe(
          Stream.tap((mode) =>
            Effect.logTrace("Updated onCellChangeMode context").pipe(
              Effect.annotateLogs({ mode }),
            ),
          ),
          Stream.tap((mode) =>
            code.commands.setContext(
              "marimo.config.runtime.on_cell_change",
              Option.getOrElse(mode, () => "autorun"),
            ),
          ),
          Stream.runDrain,
        ),
    );

    // Update auto_reload context based on current state
    yield* Effect.forkScoped(
      configService
        .streamOf((config) => config.runtime?.auto_reload)
        .pipe(
          Stream.tap((mode) =>
            Effect.logTrace("Updated autoReloadMode context").pipe(
              Effect.annotateLogs({ mode }),
            ),
          ),
          Stream.tap((mode) =>
            code.commands.setContext(
              "marimo.config.runtime.auto_reload",
              Option.getOrElse(
                Option.map(mode, (m) => m ?? ("off" as const)),
                () => "off" as const,
              ),
            ),
          ),
          Stream.runDrain,
        ),
    );
  }).pipe(Effect.annotateLogs("service", "ConfigContextManager")),
);
