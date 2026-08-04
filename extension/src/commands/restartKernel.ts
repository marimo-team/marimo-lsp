import { Effect, Option } from "effect";

import { defineCommand } from "../commands.ts";
import { CellExecutions } from "../kernel/CellExecutions.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { SessionsService } from "../panel/sessions/SessionsService.ts";
import { VsCode } from "../platform/VsCode.ts";
import type { NotebookTarget } from "./Invocation.ts";
import { MarimoCommands } from "./MarimoCommands.ts";

const handler = Effect.fn("command.restartKernel")(function* (
  target: Option.Option<NotebookTarget>,
) {
  const code = yield* VsCode;
  const sessions = yield* SessionsService;
  const executions = yield* CellExecutions;

  if (Option.isNone(target)) {
    yield* code.window.showInformationMessage(
      "No notebook editor is currently open",
    );
    return;
  }

  const { document: notebook, editor } = target.value;

  if (Option.isNone(yield* sessions.find(notebook.id))) {
    yield* code.window.showInformationMessage(
      "This notebook does not have a live kernel",
    );
    return;
  }

  const restarted = yield* code.window.withProgress(
    {
      location: code.ProgressLocation.Window,
      title: "Restarting kernel",
      cancellable: false,
    },
    Effect.fn(function* (progress) {
      progress.report({ message: "Restarting session..." });

      const succeeded = yield* sessions.restart(notebook.id).pipe(
        Effect.as(true),
        Effect.catchAllCause(
          Effect.fn(function* (cause) {
            yield* Effect.logError("Failed to restart kernel").pipe(
              Effect.annotateLogs({ cause }),
            );
            yield* showErrorAndPromptLogs("Failed to restart kernel.");
            return false;
          }),
        ),
      );

      if (!succeeded) return false;

      yield* executions.handleInterrupt(editor);

      progress.report({ message: "Kernel restarted." });
      yield* Effect.sleep("500 millis");
      return true;
    }),
  );

  if (restarted) {
    yield* code.window.showInformationMessage("Kernel restarted successfully");
  }
});

export default defineCommand(MarimoCommands.restartKernel, handler);
