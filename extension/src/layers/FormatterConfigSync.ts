import { Effect, Layer, Stream } from "effect";
import { Config } from "../services/Config.ts";
import { VsCode } from "../services/VsCode.ts";

const RUFF_EXTENSION_ID = "charliermarsh.ruff";
const MARIMO_EXTENSION_ID = "marimo-team.vscode-marimo";

/**
 * Layer that monitors Python formatter configuration and syncs it to mo-python.
 *
 * When the user has Ruff configured as their Python formatter, this layer
 * automatically configures mo-python to use marimo's managed Ruff formatter.
 * This provides a seamless experience where users don't need to manually
 * configure mo-python formatting settings.
 */
export const FormatterConfigSyncLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const config = yield* Config;

    const managedFeaturesEnabled =
      yield* config.getManagedLanguageFeaturesEnabled();

    // Only sync if managed features are enabled
    if (!managedFeaturesEnabled) {
      yield* Effect.logDebug(
        "Managed language features disabled, skipping formatter config sync",
      );
      return;
    }

    // Sync on startup
    yield* syncFormatterConfig(code);

    // Watch for configuration changes and re-sync
    yield* Effect.forkScoped(
      code.workspace.configurationChanges().pipe(
        Stream.filter(
          (event) =>
            event.affectsConfiguration("[python]") ||
            event.affectsConfiguration("ruff"),
        ),
        Stream.mapEffect(() => syncFormatterConfig(code)),
        Stream.runDrain,
      ),
    );
  }),
);

/**
 * Syncs formatter configuration from Python to mo-python.
 *
 * If the user has Ruff set as their Python formatter, we set marimo as
 * the mo-python formatter so that our managed Ruff server handles formatting.
 */
function syncFormatterConfig(code: VsCode) {
  return Effect.gen(function* () {
    const pythonConfig = yield* code.workspace.getConfiguration("[python]");
    const pythonFormatter = pythonConfig.get<string>("editor.defaultFormatter");

    const moPythonConfig =
      yield* code.workspace.getConfiguration("[mo-python]");
    const currentMoPythonFormatter = moPythonConfig.get<string>(
      "editor.defaultFormatter",
    );

    const userHasRuffForPython = pythonFormatter === RUFF_EXTENSION_ID;

    if (userHasRuffForPython && currentMoPythonFormatter === undefined) {
      yield* Effect.logInfo(
        "User has Ruff configured for Python, setting marimo as mo-python formatter",
      );

      yield* Effect.tryPromise({
        try: () =>
          moPythonConfig.update(
            "editor.defaultFormatter",
            MARIMO_EXTENSION_ID,
            1,
          ),
        catch: (error) =>
          new Error(`Failed to update mo-python config: ${error}`),
      });

      yield* Effect.logInfo("Successfully configured mo-python formatter");
    }
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logWarning("Failed to sync formatter config", { error }),
    ),
  );
}
