import * as semver from "@std/semver";
import { Data, Effect, Option, Runtime, Schema, Stream } from "effect";
import type * as vscode from "vscode";

import { MINIMUM_MARIMO_KERNEL_VERSION } from "../constants.ts";
import { SANDBOX_CONTROLLER_ID } from "../ids.ts";
import { acquireDisposable } from "../lib/acquireDisposable.ts";
import { extractExecuteCodeRequest } from "../lib/extractExecuteCodeRequest.ts";
import { extractPythonError } from "../lib/extractPythonError.ts";
import { uvAddScriptSafe } from "../lib/installPackages.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { isProblematicFilename } from "../lib/validateNotebookFilename.ts";
import { LanguageClient } from "../lsp/LanguageClient.ts";
import { Constants } from "../platform/Constants.ts";
import { OutputChannel } from "../platform/OutputChannel.ts";
import { VsCode } from "../platform/VsCode.ts";
import { getVenvPythonPath } from "../python/getVenvPythonPath.ts";
import { PythonExtension } from "../python/PythonExtension.ts";
import { Uv } from "../python/Uv.ts";
import {
  type MarimoNotebookCell,
  MarimoNotebookDocument,
  type NotebookId,
} from "../schemas/MarimoNotebookDocument.ts";
import { SemVerFromString } from "../schemas/SemVerFromString.ts";

/**
 * An error returned when a sandbox kernel is asked to run for an unsaved
 * notebook. The sandbox derives a per-notebook virtual environment from the
 * script file on disk, so the notebook must be saved first.
 */
export class UnsavedNotebookError extends Data.TaggedError(
  "UnsavedNotebookError",
)<{ readonly notebookUri: NotebookId }> {}

export class SandboxController extends Effect.Service<SandboxController>()(
  "SandboxController",
  {
    dependencies: [Uv.Default, OutputChannel.Default, Constants.Default],
    scoped: Effect.gen(function* () {
      const uv = yield* Uv;
      const code = yield* VsCode;
      const client = yield* LanguageClient;
      const python = yield* PythonExtension;
      const { LanguageId } = yield* Constants;

      const runPromise = Runtime.runPromise(
        yield* Effect.runtime<OutputChannel | VsCode>(),
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
      const resolveExecutable = Effect.fn(
        "SandboxController.resolveExecutable",
      )(function* (notebook: MarimoNotebookDocument) {
        // The sandbox venv is derived from the script file on disk; an unsaved
        // notebook has no path to sync. The run handler guards this earlier
        // (prompts to save); the scratchpad path reaches here directly.
        if (notebook.isUntitled) {
          return yield* new UnsavedNotebookError({ notebookUri: notebook.id });
        }

        const requirements = yield* findRequirements(uv, notebook);

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
      });

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
            const executable = yield* resolveExecutable(notebook);

            yield* client.executeCommand({
              command: "marimo.api",
              params: {
                method: "execute-cells",
                params: {
                  notebookUri: notebook.id,
                  executable,
                  inner: request.value,
                },
              },
            });
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
            // Log everything else
            Effect.tapErrorCause(Effect.logError),
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
            Effect.catchTag("ExecuteCommandError", (error) => {
              const detail = extractPythonError(error.cause);
              return showErrorAndPromptLogs(
                Option.isSome(detail)
                  ? `Failed to execute marimo command:\n\n${detail.value}`
                  : "Failed to communicate with marimo language server.",
                { channel: client.channel },
              );
            }),
            Effect.catchTag("LanguageClientStartError", () =>
              showErrorAndPromptLogs(
                "Failed to start marimo language server (marimo-lsp).",
              ),
            ),
            Effect.annotateLogs({ notebook: rawNotebook.uri.fsPath }),
          ),
        );

      controller.interruptHandler = (doc) =>
        runPromise(
          Effect.gen(function* () {
            const notebook = MarimoNotebookDocument.from(doc);
            yield* client.executeCommand({
              command: "marimo.api",
              params: {
                method: "interrupt",
                params: {
                  notebookUri: notebook.id,
                  inner: {},
                },
              },
            });
          }).pipe(
            Effect.withSpan("SandboxController.interrupt", {
              attributes: {
                controllerId: controller.id,
                notebook: doc.uri.toString(),
              },
            }),
            Effect.catchAllCause(
              Effect.fn(function* (cause) {
                yield* Effect.logError("Failed to interrupt execution").pipe(
                  Effect.annotateLogs({ cause }),
                );
                yield* showErrorAndPromptLogs("Failed to interrupt execution.");
              }),
            ),
          ),
        );

      return {
        _tag: "SandboxController" as const,
        id: controller.id,
        resolveExecutable,
        createNotebookCellExecution(cell: MarimoNotebookCell) {
          return controller.createNotebookCellExecution(cell.rawNotebookCell);
        },
        selectedNotebookChanges() {
          return Stream.asyncPush<{
            notebook: vscode.NotebookDocument;
            selected: boolean;
          }>((emit) =>
            acquireDisposable(() =>
              controller.onDidChangeSelectedNotebooks((e) => emit.single(e)),
            ),
          );
        },
        updateNotebookAffinity(
          notebook: vscode.NotebookDocument,
          affinity: vscode.NotebookControllerAffinity,
        ) {
          return Effect.sync(() => {
            controller.updateNotebookAffinity(notebook, affinity);
          });
        },
      };
    }),
  },
) {}

const findRequirements = (uv: Uv, notebook: MarimoNotebookDocument) =>
  Effect.gen(function* () {
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
  }).pipe(
    Effect.catchTag(
      "UvMissingPep723MetadataError",
      Effect.fn(function* () {
        yield* Effect.logDebug("No PEP 723 metadata.");
        return ["marimo"];
      }),
    ),
  );
