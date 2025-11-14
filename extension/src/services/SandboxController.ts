import * as NodePath from "node:path";
import * as semver from "@std/semver";
import { Effect, Option, Runtime, Schema, Stream } from "effect";
import type * as vscode from "vscode";
import { SemVerFromString } from "../schemas.ts";
import { getNotebookUri } from "../types.ts";
import { getCellExecutableCode } from "../utils/getCellExecutableCode.ts";
import { uvAddScriptSafe } from "../utils/installPackages.ts";
import { getNotebookCellId } from "../utils/notebook.ts";
import { showErrorAndPromptLogs } from "../utils/showErrorAndPromptLogs.ts";
import { MINIMUM_MARIMO_VERSION } from "./EnvironmentValidator.ts";
import { LanguageClient } from "./LanguageClient.ts";
import { OutputChannel } from "./OutputChannel.ts";
import { PythonExtension } from "./PythonExtension.ts";
import { Uv } from "./Uv.ts";
import { VsCode } from "./VsCode.ts";

export class SandboxController extends Effect.Service<SandboxController>()(
  "SandboxController",
  {
    dependencies: [Uv.Default, OutputChannel.Default],
    scoped: Effect.gen(function* () {
      const uv = yield* Uv;
      const code = yield* VsCode;
      const channel = yield* OutputChannel;
      const client = yield* LanguageClient;
      const python = yield* PythonExtension;

      const runPromise = Runtime.runPromise(yield* Effect.runtime());

      const controller = yield* code.notebooks.createNotebookController(
        "marimo-sandbox",
        "marimo-notebook",
        "marimo sandbox",
      );

      // Add metadata
      controller.supportedLanguages = ["python", "sql"];
      controller.description = "marimo sandbox controller";

      // Set up execution handler
      controller.executeHandler = (cells, notebook) =>
        runPromise<void, never>(
          Effect.gen(function* () {
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

              yield* Effect.promise(() => notebook.save());
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
            const venv = yield* uv.syncScript({ script: notebook.uri.fsPath });
            const executable = NodePath.join(venv, "bin", "python");
            yield* python.updateActiveEnvironmentPath(executable);

            yield* client.executeCommand({
              command: "marimo.api",
              params: {
                method: "run",
                params: {
                  notebookUri: getNotebookUri(notebook),
                  executable,
                  inner: {
                    cellIds: cells.map((cell) => getNotebookCellId(cell)),
                    codes: cells.map((cell) => getCellExecutableCode(cell)),
                  },
                },
              },
            });
          }).pipe(
            // Log everything
            Effect.tapErrorCause(Effect.logError),
            Effect.catchTag("UvExecutionError", () =>
              showErrorAndPromptLogs(
                "Failed to execute uv. Ensure uv is installed and accessible in your PATH.",
                {
                  code,
                  channel: uv.channel,
                },
              ),
            ),
            Effect.catchTag("UvUnknownError", () =>
              showErrorAndPromptLogs(
                "uv command failed. Check the logs for details.",
                {
                  code,
                  channel: uv.channel,
                },
              ),
            ),
            Effect.catchTag("UvResolutionError", () =>
              showErrorAndPromptLogs(
                "Dependency conflict. Your notebook has conflicting package version requirements.",
                {
                  code,
                  channel: uv.channel,
                },
              ),
            ),
            Effect.catchTag("ExecuteCommandError", () =>
              showErrorAndPromptLogs(
                "Failed to communicate with marimo language server.",
                { code, channel: client.channel },
              ),
            ),
            Effect.catchTag("LanguageClientStartError", () =>
              showErrorAndPromptLogs(
                "Failed to start marimo language server (marimo-lsp).",
                { code, channel },
              ),
            ),
            Effect.annotateLogs({ notebook: notebook.uri.fsPath }),
          ),
        );

      controller.interruptHandler = (doc) =>
        runPromise(
          Effect.gen(function* () {
            yield* Effect.logInfo("Interrupting execution").pipe(
              Effect.annotateLogs({
                controllerId: controller.id,
                notebook: getNotebookUri(doc),
              }),
            );
            yield* client.executeCommand({
              command: "marimo.api",
              params: {
                method: "interrupt",
                params: {
                  notebookUri: getNotebookUri(doc),
                  inner: {},
                },
              },
            });
          }).pipe(
            Effect.catchAllCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logError(cause);
                yield* showErrorAndPromptLogs(
                  "Failed to interrupt execution.",
                  { code, channel },
                );
              }),
            ),
          ),
        );

      return {
        id: controller.id,
        createNotebookCellExecution(cell: vscode.NotebookCell) {
          return controller.createNotebookCellExecution(cell);
        },
        selectedNotebookChanges() {
          return Stream.asyncPush<{
            notebook: vscode.NotebookDocument;
            selected: boolean;
          }>((emit) =>
            Effect.acquireRelease(
              Effect.sync(() =>
                controller.onDidChangeSelectedNotebooks((e) => emit.single(e)),
              ),
              (disposable) => Effect.sync(() => disposable.dispose()),
            ),
          );
        },
      };
    }),
  },
) {}

const findRequirements = (uv: Uv, notebook: vscode.NotebookDocument) =>
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
