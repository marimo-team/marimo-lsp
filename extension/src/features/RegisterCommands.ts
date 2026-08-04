import { Effect, Either, Layer, Stream } from "effect";

import { createSetupCellCommand } from "../commands/createSetupCell.ts";
import { debugCellCommand } from "../commands/debugCell.ts";
import { exportNotebookAsHtmlCommand } from "../commands/exportNotebookAsHtml.ts";
import { newMarimoNotebookCommand } from "../commands/newMarimoNotebook.ts";
import { openAsMarimoNotebookCommand } from "../commands/openAsMarimoNotebook.ts";
import { openOutlineViewCommand } from "../commands/openOutlineView.ts";
import { publishMarimoNotebookCommand } from "../commands/publishMarimoNotebook.ts";
import { reportIssueCommand } from "../commands/reportIssue.ts";
import { restartKernelCommand } from "../commands/restartKernel.ts";
import { restartLspCommand } from "../commands/restartLsp.ts";
import { runStaleCommand } from "../commands/runStale.ts";
import {
  hideCellCodeCommand,
  showCellCodeCommand,
} from "../commands/setCellCodeVisibility.ts";
import { showDiagnosticsCommand } from "../commands/showDiagnostics.ts";
import { showNotebookMenuCommand } from "../commands/showNotebookMenu.ts";
import { updateActivePythonEnvironmentCommand } from "../commands/updateActivePythonEnvironment.ts";
import { updateCellMetadataCommand } from "../commands/updateCellMetadata.ts";
import { VsCode } from "../platform/VsCode.ts";
import { Telemetry } from "../telemetry/Telemetry.ts";

/**
 * Registers VS Code commands for the marimo extension.
 */
export const RegisterCommandsLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const telemetry = yield* Telemetry;

    yield* code.commands.register(newMarimoNotebookCommand);
    yield* code.commands.register(createSetupCellCommand);
    yield* code.commands.register(openAsMarimoNotebookCommand);
    yield* code.commands.register(openOutlineViewCommand);
    yield* code.commands.register(publishMarimoNotebookCommand);
    yield* code.commands.register(runStaleCommand);
    yield* code.commands.register(showNotebookMenuCommand);
    yield* code.commands.register(debugCellCommand);
    yield* code.commands.register(hideCellCodeCommand);
    yield* code.commands.register(showCellCodeCommand);
    yield* code.commands.register(restartKernelCommand);
    yield* code.commands.register(restartLspCommand);
    yield* code.commands.register(showDiagnosticsCommand);
    yield* code.commands.register(reportIssueCommand);
    yield* code.commands.register(exportNotebookAsHtmlCommand);
    yield* code.commands.register(updateActivePythonEnvironmentCommand);
    yield* code.commands.register(updateCellMetadataCommand);

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
