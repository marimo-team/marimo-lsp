import { Effect, Either, Layer, Stream } from "effect";

import createSetupCell from "../commands/createSetupCell.ts";
import debugCell from "../commands/debugCell.ts";
import exportNotebookAsHtml from "../commands/exportNotebookAsHtml.ts";
import hideCellCode from "../commands/hideCellCode.ts";
import newMarimoNotebook from "../commands/newMarimoNotebook.ts";
import openAsMarimoNotebook from "../commands/openAsMarimoNotebook.ts";
import openOutlineView from "../commands/openOutlineView.ts";
import publishMarimoNotebook from "../commands/publishMarimoNotebook.ts";
import reportIssue from "../commands/reportIssue.ts";
import restartKernel from "../commands/restartKernel.ts";
import restartLsp from "../commands/restartLsp.ts";
import runStale from "../commands/runStale.ts";
import showCellCode from "../commands/showCellCode.ts";
import showDiagnostics from "../commands/showDiagnostics.ts";
import showNotebookMenu from "../commands/showNotebookMenu.ts";
import updateActivePythonEnvironment from "../commands/updateActivePythonEnvironment.ts";
import updateCellMetadata from "../commands/updateCellMetadata.ts";
import { VsCode } from "../platform/VsCode.ts";
import { Telemetry } from "../telemetry/Telemetry.ts";

/**
 * Registers VS Code commands for the marimo extension.
 */
export const RegisterCommandsLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const telemetry = yield* Telemetry;

    yield* code.commands.register(newMarimoNotebook);
    yield* code.commands.register(createSetupCell);
    yield* code.commands.register(openAsMarimoNotebook);
    yield* code.commands.register(openOutlineView);
    yield* code.commands.register(publishMarimoNotebook);
    yield* code.commands.register(runStale);
    yield* code.commands.register(showNotebookMenu);
    yield* code.commands.register(debugCell);
    yield* code.commands.register(hideCellCode);
    yield* code.commands.register(showCellCode);
    yield* code.commands.register(restartKernel);
    yield* code.commands.register(restartLsp);
    yield* code.commands.register(showDiagnostics);
    yield* code.commands.register(reportIssue);
    yield* code.commands.register(exportNotebookAsHtml);
    yield* code.commands.register(updateActivePythonEnvironment);
    yield* code.commands.register(updateCellMetadata);

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
