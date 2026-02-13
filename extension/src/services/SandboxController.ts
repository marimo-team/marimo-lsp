import type * as vscode from "vscode";

import * as semver from "@std/semver";
import { Effect, Option, Runtime, Schema, Stream } from "effect";

import { SANDBOX_CONTROLLER_ID } from "../ids.ts";
import {
  type MarimoNotebookCell,
  MarimoNotebookDocument,
  SemVerFromString,
} from "../schemas.ts";
import { acquireDisposable } from "../utils/acquireDisposable.ts";
import { extractExecuteCodeRequest } from "../utils/extractExecuteCodeRequest.ts";
import { getVenvPythonPath } from "../utils/getVenvPythonPath.ts";
import { uvAddScriptSafe } from "../utils/installPackages.ts";
import { showErrorAndPromptLogs } from "../utils/showErrorAndPromptLogs.ts";
import { Constants } from "./Constants.ts";
import { MINIMUM_MARIMO_VERSION } from "./EnvironmentValidator.ts";
import { LanguageClient } from "./LanguageClient.ts";
import { OutputChannel } from "./OutputChannel.ts";
import { PythonExtension } from "./PythonExtension.ts";
import { Uv } from "./Uv.ts";
import { VsCode } from "./VsCode.ts";

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

      // Set up execution handler
      controller.executeHandler = (rawCells, rawNotebook) =>
        runPromise<void, never>(
          Effect.gen(function* () {
            const request = extractExecuteCodeRequest(rawCells, LanguageId);

            if (Option.isNone(request)) {
              return yield* Effect.logWarning("Empty execution request").pipe(
                Effect.annotateLogs({ rawCells }),
              );
            }

            const notebook = MarimoNotebookDocument.from(rawNotebook);

            // sandboxing only works with titled (saved) notebooks
            if (notebook.isUntitled) {
              const choice = yield* code.window.showInformationMessage(
                "Sandboxing requires a saved file. Please save your notebook and re-run cells.",
                {
                  modal: true,
                  items: ["Save"],
                },
              );

              if (Option.isNone(choice)) {
                return;
              }

              yield* notebook.save();
              return;
            }

            const requirements = yield* findRequirements(uv, notebook);

            if (requirements.length > 0) {
              yield* uvAddScriptSafe(requirements, notebook).pipe(
                Effect.provideService(VsCode, code),
                Effect.provideService(Uv, uv),
              );
            }

            // always ensure the env is up to date
            const venv = yield* uv
              .syncScript({ script: notebook.uri.fsPath })
              .pipe(
                // Should be added by findRequirements or uvAddScriptSafe
                Effect.catchTag("UvMissingPep723MetadataError", () =>
                  Effect.die("Expected PEP 723 metadata to be present"),
                ),
              );

            const executable = getVenvPythonPath(venv);
            yield* python.updateActiveEnvironmentPath(executable);

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
            // Log everything
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
            Effect.catchTag("ExecuteCommandError", () =>
              showErrorAndPromptLogs(
                "Failed to communicate with marimo language server.",
                { channel: client.channel },
              ),
            ),
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
              Effect.fnUntraced(function* (cause) {
                yield* Effect.logError("Failed to interrupt execution").pipe(
                  Effect.annotateLogs({ cause }),
                );
                yield* showErrorAndPromptLogs("Failed to interrupt execution.");
              }),
            ),
          ),
        );

      return {
        id: controller.id,
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
    let pyzmqOk = false;

    for (const pkg of packages.split("\n")) {
      if (pkg.startsWith("marimo ")) {
        const version = Schema.decodeOption(SemVerFromString)(
          pkg.slice(0, "marimo ".length),
        );

        if (
          Option.isSome(version) &&
          semver.greaterOrEqual(version.value, MINIMUM_MARIMO_VERSION)
        ) {
          marimoOk = true;
        }
      }
      if (pkg.startsWith("pyzmq ")) {
        pyzmqOk = true;
      }
    }

    const requirements = [];
    if (!marimoOk) {
      requirements.push(`marimo>=${semver.format(MINIMUM_MARIMO_VERSION)}`);
    }
    if (!pyzmqOk) {
      requirements.push("pyzmq");
    }

    return requirements satisfies ReadonlyArray<string>;
  }).pipe(
    Effect.catchTag(
      "UvMissingPep723MetadataError",
      Effect.fnUntraced(function* () {
        yield* Effect.logDebug("No PEP 723 metadata.");
        return ["marimo", "pyzmq"];
      }),
    ),
  );
