import { Effect, Layer, Option, Stream } from "effect";

import { VsCode } from "../services/VsCode.ts";

/**
 * Watches for changes to `marimo.languageFeatures` (and the deprecated
 * `marimo.disableManagedLanguageFeatures`) and prompts the user to reload the
 * window, since this setting is read at startup and baked into service
 * initialization.
 */
export const ReloadOnConfigChangeLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;

    yield* Effect.forkScoped(
      code.workspace.configurationChanges().pipe(
        Stream.filter(
          (event) =>
            event.affectsConfiguration("marimo.languageFeatures") ||
            event.affectsConfiguration("marimo.disableManagedLanguageFeatures"),
        ),
        Stream.runForEach(() =>
          Effect.gen(function* () {
            const reload = yield* code.window.showInformationMessage(
              "Changing the language features mode requires reloading the window to take effect.",
              { items: ["Reload Window"] },
            );

            if (Option.isSome(reload) && reload.value === "Reload Window") {
              yield* code.commands.executeCommand(
                "workbench.action.reloadWindow",
              );
            }
          }),
        ),
      ),
    );
  }),
);
