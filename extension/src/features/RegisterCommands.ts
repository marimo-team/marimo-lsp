import { Effect, Either, Layer, Stream } from "effect";

import { createSetupCell } from "../commands/createSetupCell.ts";
import { debugCell } from "../commands/debugCell.ts";
import { exportNotebookAsHtml } from "../commands/exportNotebookAsHtml.ts";
import { MarimoCommands } from "../commands/MarimoCommands.ts";
import { newMarimoNotebook } from "../commands/newMarimoNotebook.ts";
import { openAsMarimoNotebook } from "../commands/openAsMarimoNotebook.ts";
import { openOutlineView } from "../commands/openOutlineView.ts";
import { publishMarimoNotebook } from "../commands/publishMarimoNotebook.ts";
import { reportIssue } from "../commands/reportIssue.ts";
import { restartKernel } from "../commands/restartKernel.ts";
import { restartLsp } from "../commands/restartLsp.ts";
import { runStale } from "../commands/runStale.ts";
import { setCellCodeVisibility } from "../commands/setCellCodeVisibility.ts";
import { showDiagnostics } from "../commands/showDiagnostics.ts";
import { showNotebookMenu } from "../commands/showNotebookMenu.ts";
import { updateActivePythonEnvironment } from "../commands/updateActivePythonEnvironment.ts";
import { VsCode } from "../platform/VsCode.ts";
import { Telemetry } from "../telemetry/Telemetry.ts";

/**
 * Registers VS Code commands for the marimo extension.
 */
export const RegisterCommandsLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const telemetry = yield* Telemetry;

    yield* code.commands.register(
      MarimoCommands.newMarimoNotebook,
      newMarimoNotebook,
    );

    yield* code.commands.register(
      MarimoCommands.createSetupCell,
      createSetupCell,
    );

    yield* code.commands.register(
      MarimoCommands.openAsMarimoNotebook,
      openAsMarimoNotebook,
    );

    yield* code.commands.register(
      MarimoCommands.openOutlineView,
      openOutlineView,
    );

    yield* code.commands.register(
      MarimoCommands.publishMarimoNotebook,
      publishMarimoNotebook,
    );

    yield* code.commands.register(MarimoCommands.runStale, runStale);
    yield* code.commands.register(
      MarimoCommands.showNotebookMenu,
      showNotebookMenu,
    );
    yield* code.commands.register(MarimoCommands.debugCell, debugCell);
    yield* code.commands.register(MarimoCommands.hideCellCode, (cell) =>
      setCellCodeVisibility(cell, true),
    );
    yield* code.commands.register(MarimoCommands.showCellCode, (cell) =>
      setCellCodeVisibility(cell, false),
    );

    yield* code.commands.register(restartKernel.command, restartKernel.handler);

    yield* code.commands.register(MarimoCommands.restartLsp, restartLsp);

    yield* code.commands.register(
      MarimoCommands.showDiagnostics,
      showDiagnostics,
    );

    yield* code.commands.register(MarimoCommands.reportIssue, reportIssue);

    yield* code.commands.register(
      MarimoCommands.exportStaticHTML,
      exportNotebookAsHtml,
    );

    yield* code.commands.register(
      MarimoCommands.updateActivePythonEnvironment,
      updateActivePythonEnvironment,
    );

    // Telemetry for commands
    const queue = yield* code.commands.subscribeToCommands();
    yield* Effect.forkScoped(
      queue.pipe(
        Stream.runForEach(
          Effect.fn(function* (result) {
            if (Either.isLeft(result)) {
              yield* telemetry.commandExecuted(result.left, false);
            } else {
              yield* telemetry.commandExecuted(result.right, true);
            }
          }),
        ),
        Stream.runDrain,
      ),
    );
  }),
);
