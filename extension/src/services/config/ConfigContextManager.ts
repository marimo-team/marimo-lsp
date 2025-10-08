import { Effect, Option, Stream } from "effect";
import { Log } from "../../utils/log.ts";
import { VsCode } from "../VsCode.ts";
import { MarimoConfigurationService } from "./MarimoConfigurationService.ts";

/**
 * Manages configuration context keys across all notebooks.
 *
 * Tracks configuration state and updates VSCode context keys for UI:
 * - "marimo.config.runtime.on_cell_change" - Current on_cell_change mode ("autorun" | "lazy")
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

      // Update context based on current state
      // Run indefinitely
      yield* Effect.forkScoped(
        onCellChangeModeStream.pipe(
          Stream.mapEffect(
            Effect.fnUntraced(function* (mode) {
              yield* code.commands.setContext(
                "marimo.config.runtime.on_cell_change",
                Option.getOrElse(mode, () => "autorun"),
              );
              yield* Log.debug("Updated onCellChangeMode context", { mode });
            }),
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
      };
    }).pipe(Effect.annotateLogs("service", "ConfigContextManager")),
  },
) {}
