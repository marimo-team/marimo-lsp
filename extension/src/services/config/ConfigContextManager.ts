import { Effect, Option, Stream } from "effect";
import { VsCode } from "../VsCode.ts";
import { MarimoConfigurationService } from "./MarimoConfigurationService.ts";

/**
 * Manages configuration context keys across all notebooks.
 *
 * Tracks configuration state and updates VSCode context keys for UI:
 * - "marimo.config.runtime.on_cell_change" - Current on_cell_change mode ("autorun" | "lazy")
 * - "marimo.config.runtime.auto_reload" - Current auto_reload mode ("off" | "lazy" | "autorun")
 *
 * Uses SubscriptionRef for reactive state management.
 */
export class ConfigContextManager extends Effect.Service<ConfigContextManager>()(
  "ConfigContextManager",
  {
    dependencies: [MarimoConfigurationService.Default],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const configService = yield* MarimoConfigurationService;

      const onCellChangeModeStream = configService.streamOf(
        (config) => config.runtime?.on_cell_change,
      );

      const autoReloadModeStream = configService.streamOf(
        (config) => config.runtime?.auto_reload,
      );

      // Update on_cell_change context based on current state
      yield* Effect.forkScoped(
        onCellChangeModeStream.pipe(
          Stream.tap((mode) =>
            Effect.logDebug("Updated onCellChangeMode context").pipe(
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
        autoReloadModeStream.pipe(
          Stream.tap((mode) =>
            Effect.logDebug("Updated autoReloadMode context").pipe(
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

      return {
        /**
         * Stream of on_cell_change mode changes
         */
        streamOnCellChangeModeChanges() {
          return onCellChangeModeStream;
        },
        /**
         * Stream of auto_reload mode changes
         */
        streamAutoReloadModeChanges() {
          return autoReloadModeStream;
        },
      };
    }).pipe(Effect.annotateLogs("service", "ConfigContextManager")),
  },
) {}
