import * as semver from "@std/semver";
import { Effect, flow, Option, Schema } from "effect";
import type * as vscode from "vscode";

import { MINIMUM_MARIMO_KERNEL_VERSION } from "../constants.ts";
import { SANDBOX_CONTROLLER_ID } from "../ids.ts";
import { extractExecuteCodeRequest } from "../lib/extractExecuteCodeRequest.ts";
import { extractPythonError } from "../lib/extractPythonError.ts";
import { uvAddScriptSafe } from "../lib/installPackages.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { isProblematicFilename } from "../lib/validateNotebookFilename.ts";
import { MarimoClient } from "../lsp/MarimoClient.ts";
import { Constants } from "../platform/Constants.ts";
import { OutputChannel } from "../platform/OutputChannel.ts";
import { VsCode } from "../platform/VsCode.ts";
import { getVenvPythonPath } from "../python/getVenvPythonPath.ts";
import { PythonExtension } from "../python/PythonExtension.ts";
import { Uv } from "../python/Uv.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";
import { SemVerFromString } from "../schemas/SemVerFromString.ts";
import { makeControllerSelectionChanges } from "./ControllerSelectionChanges.ts";
import {
  ExecutableResolutionError,
  NotebookRuntime,
  UnsavedNotebookError,
} from "./NotebookRuntime.ts";
import { VsCodeCellDrive } from "./VsCodeCellDrive.ts";

export const createSandboxController = Effect.fn("createSandboxController")(
  function* () {
    const uv = yield* Uv;
    const code = yield* VsCode;
    const cellDrive = yield* VsCodeCellDrive;
    const marimo = yield* MarimoClient;
    const notebooks = yield* NotebookRuntime;
    const python = yield* PythonExtension;
    const { LanguageId } = yield* Constants;

    const runPromise = Effect.runPromiseWith(
      yield* Effect.context<OutputChannel | VsCode>(),
    );

    const controller = yield* code.notebooks.createNotebookController(
      SANDBOX_CONTROLLER_ID,
      "marimo-notebook",
      "marimo sandbox",
    );

    // Add metadata
    controller.supportedLanguages = [LanguageId.Python, LanguageId.Sql];
    controller.description = "marimo sandbox controller";

    // Sync the script's PEP 723 env and return the venv interpreter.
    const resolveExecutable = Effect.fn("SandboxController.resolveExecutable")(
      function* (notebook: MarimoNotebookDocument) {
        // The sandbox venv is derived from the script file on disk; an unsaved
        // notebook has no path to sync. The run handler guards this earlier
        // (prompts to save); the scratchpad path reaches here directly.
        if (notebook.isUntitled) {
          return yield* new UnsavedNotebookError({ notebookUri: notebook.id });
        }

        const requirements = yield* findRequirements(notebook);

        if (requirements.length > 0) {
          yield* uvAddScriptSafe(requirements, notebook).pipe(
            Effect.provideService(VsCode, code),
            Effect.provideService(Uv, uv),
          );
        }

        // always ensure the env is up to date
        const venv = yield* uv.syncScript({ script: notebook.uri.fsPath }).pipe(
          // Should be added by findRequirements or uvAddScriptSafe
          Effect.catchTag("UvMissingPep723MetadataError", () =>
            Effect.die("Expected PEP 723 metadata to be present"),
          ),
        );

        const executable = getVenvPythonPath(venv);
        yield* python.updateActiveEnvironmentPath(executable);
        return executable;
      },
    );

    // Set up execution handler
    controller.executeHandler = (rawCells, rawNotebook) =>
      runPromise<void, never>(
        Effect.gen(function* () {
          const request = extractExecuteCodeRequest(rawCells, LanguageId);

          if (Option.isNone(request)) {
            yield* Effect.logWarning("Empty execution request").pipe(
              Effect.annotateLogs({ rawCells }),
            );
            return;
          }

          const notebook = MarimoNotebookDocument.from(rawNotebook);

          const validation = isProblematicFilename(rawNotebook.uri);
          if (validation.problematic) {
            yield* code.window.showErrorMessage(validation.message, {
              modal: true,
            });
            return;
          }

          // resolveExecutable rejects unsaved notebooks (UnsavedNotebookError),
          // handled below with an interactive save prompt.
          const executable = yield* resolveExecutable(notebook).pipe(
            Effect.provideService(Uv, uv),
          );

          const documentHandle = yield* notebooks.forDocument(rawNotebook);
          yield* documentHandle.executeCells(request.value, executable);
        }).pipe(
          // Handle the expected "unsaved notebook" path before logging, so a
          // normal save prompt isn't recorded as an error. (sandboxing only
          // works with titled/saved notebooks)
          Effect.catchTag("UnsavedNotebookError", () =>
            Effect.gen(function* () {
              const choice = yield* code.window.showInformationMessage(
                "Sandboxing requires a saved file. Please save your notebook and re-run cells.",
                { modal: true, items: ["Save"] },
              );
              if (Option.isSome(choice)) {
                yield* MarimoNotebookDocument.from(rawNotebook).save();
              }
            }),
          ),
          Effect.catchTag("NotebookFileRootError", (error) =>
            code.window.showErrorMessage(error.message, { modal: true }),
          ),
          Effect.catchTag("NoActiveKernelError", () =>
            code.window.showErrorMessage(
              "The notebook was closed before its kernel could start.",
              { modal: true },
            ),
          ),
          // Log everything else
          Effect.tapCause(Effect.logError),
          Effect.catchTag("UvExecutionError", () =>
            showErrorAndPromptLogs(
              "Failed to execute uv. Ensure uv is installed and accessible in your PATH.",
              { channel: uv.channel },
            ),
          ),
          Effect.catchTag("UvUnknownError", () =>
            showErrorAndPromptLogs(
              "uv command failed. Check the logs for details.",
              { channel: uv.channel },
            ),
          ),
          Effect.catchTag("UvResolutionError", () =>
            showErrorAndPromptLogs(
              "Dependency conflict. Your notebook has conflicting package version requirements.",
              { channel: uv.channel },
            ),
          ),
          Effect.catchTag("MarimoCommandError", (error) => {
            const detail = extractPythonError(error.cause);
            return showErrorAndPromptLogs(
              Option.isSome(detail)
                ? `Failed to execute marimo command:\n\n${detail.value}`
                : "Failed to communicate with marimo language server.",
              { channel: marimo.channel },
            );
          }),
          Effect.catchTag("MarimoClientStartError", () =>
            showErrorAndPromptLogs(
              "Failed to start marimo language server (marimo-lsp).",
            ),
          ),
          Effect.catchTag("SchemaError", (error) =>
            showErrorAndPromptLogs(
              "marimo language server sent a response the extension could not parse.",
              { channel: marimo.channel },
            ).pipe(Effect.annotateLogs({ error: String(error) })),
          ),
          Effect.annotateLogs({ notebook: rawNotebook.uri.fsPath }),
        ),
      );

    controller.interruptHandler = (doc) =>
      runPromise(
        Effect.gen(function* () {
          const notebook = MarimoNotebookDocument.from(doc);
          yield* notebooks.forNotebook(notebook.id).interrupt;
        }).pipe(
          Effect.withSpan("SandboxController.interrupt", {
            attributes: {
              controllerId: controller.id,
              notebook: doc.uri.toString(),
            },
          }),
          Effect.catchCause(
            Effect.fn(function* (cause) {
              yield* Effect.logError("Failed to interrupt execution").pipe(
                Effect.annotateLogs({ cause }),
              );
              yield* showErrorAndPromptLogs("Failed to interrupt execution.");
            }),
          ),
        ),
      );

    // VS Code restores a persisted controller selection as soon as the
    // controller is registered, which can happen before any subscriber fiber
    // runs. Attach the listener in the same fiber turn as creation so a
    // restored selection buffers in the queue instead of firing unheard.
    const selectedNotebookChanges =
      yield* makeControllerSelectionChanges(controller);

    return {
      id: controller.id,
      resolveExecutable: (notebook: MarimoNotebookDocument) =>
        resolveExecutable(notebook).pipe(
          Effect.provideService(Uv, uv),
          Effect.mapError((error) =>
            error._tag === "UnsavedNotebookError"
              ? error
              : new ExecutableResolutionError({
                  notebookUri: notebook.id,
                  cause: error,
                }),
          ),
        ),
      drive: (notebook: MarimoNotebookDocument) =>
        cellDrive.bind({
          notebook,
          controller: {
            createNotebookCellExecution: (cell) =>
              controller.createNotebookCellExecution(cell.rawNotebookCell),
          },
        }),
      selectedNotebookChanges,
      updateNotebookAffinity(
        notebook: vscode.NotebookDocument,
        affinity: vscode.NotebookControllerAffinity,
      ) {
        return Effect.sync(() => {
          controller.updateNotebookAffinity(notebook, affinity);
        });
      },
    };
  },
);

const findRequirements = Effect.fn(
  function* (notebook: MarimoNotebookDocument) {
    const uv = yield* Uv;
    const packages = yield* uv.currentDeps({
      script: notebook.uri.fsPath,
    });

    let marimoOk = false;

    for (const pkg of packages.split("\n")) {
      if (pkg.startsWith("marimo ")) {
        const version = Schema.decodeOption(SemVerFromString)(
          pkg.slice(0, "marimo ".length),
        );

        if (
          Option.isSome(version) &&
          semver.greaterOrEqual(version.value, MINIMUM_MARIMO_KERNEL_VERSION)
        ) {
          marimoOk = true;
        }
      }
    }

    const requirements = [];
    if (!marimoOk) {
      requirements.push(
        `marimo>=${semver.format(MINIMUM_MARIMO_KERNEL_VERSION)}`,
      );
    }

    return requirements satisfies ReadonlyArray<string>;
  },
  flow(
    Effect.catchTag(
      "UvMissingPep723MetadataError",
      Effect.fn(function* () {
        yield* Effect.logDebug("No PEP 723 metadata.");
        return ["marimo"];
      }),
    ),
  ),
);
