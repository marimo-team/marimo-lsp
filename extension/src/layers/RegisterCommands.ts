import { Effect, Either, Layer, Stream } from "effect";
import { createSetupCell } from "../commands/createSetupCell.ts";
import { exportNotebookAsHtml } from "../commands/exportNotebookAsHtml.ts";
import { newMarimoNotebook } from "../commands/newMarimoNotebook.ts";
import { openAsMarimoNotebook } from "../commands/openAsMarimoNotebook.ts";
import { publishMarimoNotebook } from "../commands/publishMarimoNotebook.ts";
import { publishMarimoNotebookGist } from "../commands/publishMarimoNotebookGist.ts";
import { reportIssue } from "../commands/reportIssue.ts";
import { restartKernel } from "../commands/restartKernel.ts";
import { restartLsp } from "../commands/restartLsp.ts";
import { runStale } from "../commands/runStale.ts";
import { showDiagnostics } from "../commands/showDiagnostics.ts";
import { toggleAutoReload } from "../commands/toggleAutoReload.ts";
import { toggleOnCellChange } from "../commands/toggleOnCellChange.ts";
import { updateActivePythonEnvironment } from "../commands/updateActivePythonEnvironment.ts";
import type { MarimoCommand } from "../constants.ts";
import { Telemetry } from "../services/Telemetry.ts";
import { VsCode } from "../services/VsCode.ts";

/**
 * Registers VS Code commands for the marimo extension.
 */
export const RegisterCommandsLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const telemetry = yield* Telemetry;

    yield* code.commands.registerCommand(
      "marimo.newMarimoNotebook",
      newMarimoNotebook,
    );

    yield* code.commands.registerCommand(
      "marimo.createSetupCell",
      createSetupCell,
    );

    yield* code.commands.registerCommand(
      "marimo.openAsMarimoNotebook",
      openAsMarimoNotebook,
    );

    yield* code.commands.registerCommand(
      "marimo.publishMarimoNotebookGist",
      publishMarimoNotebookGist,
    );

    yield* code.commands.registerCommand(
      "marimo.publishMarimoNotebook",
      publishMarimoNotebook,
    );

    yield* code.commands.registerCommand("marimo.runStale", runStale);

    for (const command of [
      "marimo.config.toggleOnCellChangeAutoRun",
      "marimo.config.toggleOnCellChangeLazy",
    ] satisfies ReadonlyArray<MarimoCommand>) {
      yield* code.commands.registerCommand(command, toggleOnCellChange);
    }

    for (const command of [
      "marimo.config.toggleAutoReloadOff",
      "marimo.config.toggleAutoReloadLazy",
      "marimo.config.toggleAutoReloadAutorun",
    ] satisfies ReadonlyArray<MarimoCommand>) {
      yield* code.commands.registerCommand(command, toggleAutoReload);
    }

    yield* code.commands.registerCommand("marimo.restartKernel", restartKernel);

    yield* code.commands.registerCommand("marimo.restartLsp", restartLsp);

    yield* code.commands.registerCommand(
      "marimo.showDiagnostics",
      showDiagnostics,
    );

    yield* code.commands.registerCommand("marimo.reportIssue", reportIssue);

    yield* code.commands.registerCommand(
      "marimo.exportStaticHTML",
      exportNotebookAsHtml,
    );

    yield* code.commands.registerCommand(
      "marimo.updateActivePythonEnvironment",
      updateActivePythonEnvironment,
    );

    // Telemetry for commands
    const queue = yield* code.commands.subscribeToCommands();
    yield* Effect.forkScoped(
      queue.pipe(
        Stream.runForEach(
          Effect.fnUntraced(function* (result) {
            if (Either.isLeft(result)) {
              yield* telemetry.capture("executed_command", {
                command: result.left,
                success: false,
              });
            } else {
              yield* telemetry.capture("executed_command", {
                command: result.right,
                success: true,
              });
            }
          }),
        ),
        Stream.runDrain,
      ),
    );
  }),
);
