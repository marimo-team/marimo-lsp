import * as semver from "@std/semver";
import { Effect, Option, Runtime, Schema } from "effect";
import type * as vscode from "vscode";
import { SemVerFromString } from "../schemas.ts";
import { getNotebookUri } from "../types.ts";
import { uvAddScriptSafe } from "../utils/installPackages.ts";
import { LanguageClient } from "./LanguageClient.ts";
import { PythonExtension } from "./PythonExtension.ts";
import { Uv } from "./Uv.ts";
import { VsCode } from "./VsCode.ts";

export class SandboxController extends Effect.Service<SandboxController>()(
  "SandboxController",
  {
    scoped: Effect.gen(function* () {
      const uv = yield* Uv;
      const code = yield* VsCode;
      const client = yield* LanguageClient;
      const python = yield* PythonExtension;

      const runPromise = Runtime.runPromise(yield* Effect.runtime());

      const controller = yield* code.notebooks.createNotebookController(
        "marimo-sandbox",
        "marimo-notebook",
        "marimo sandbox",
      );

      // Add metadata
      controller.supportedLanguages = ["python"];
      controller.description = "marimo sandbox controller";

      // Set up execution handler
      controller.executeHandler = (cells, notebook) =>
        runPromise(
          Effect.gen(function* () {
            const requirements = yield* findRequirements(uv, notebook);

            if (requirements.length > 0) {
              yield* uvAddScriptSafe(requirements, notebook).pipe(
                Effect.provideService(VsCode, code),
                Effect.provideService(Uv, uv),
              );
            }

            // always make sure the env is up to date
            const venv = yield* uv.sync({ script: notebook.uri.fsPath });
            const executable = `${venv}/bin/python`;
            yield* python.updateActiveEnvironmentPath(executable);

            yield* client.executeCommand({
              command: "marimo.api",
              params: {
                method: "run",
                params: {
                  notebookUri: getNotebookUri(notebook),
                  executable,
                  inner: {
                    cellIds: cells.map((cell) => cell.document.uri.toString()),
                    codes: cells.map((cell) => cell.document.getText()),
                  },
                },
              },
            });
          }).pipe(
            Effect.catchAll(Effect.logError),
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
                yield* code.window.showErrorMessage(
                  "Failed to interrupt execution. Please check the logs for details.",
                );
              }),
            ),
          ),
        );

      return {
        createNotebookCellExecution(cell: vscode.NotebookCell) {
          return controller.createNotebookCellExecution(cell);
        },
      };
    }),
  },
) {}

const findRequirements = (uv: Uv, notebook: vscode.NotebookDocument) =>
  Effect.gen(function* () {
    const marimoVersion = { major: 0, minor: 16, patch: 0 };
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
          semver.greaterOrEqual(version.value, marimoVersion)
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
      requirements.push(`marimo>=${semver.format(marimoVersion)}`);
    }
    if (!pyzmqOk) {
      requirements.push("pyzmq");
    }

    return requirements satisfies ReadonlyArray<string>;
  }).pipe(
    Effect.catchTag(
      "MissingPep723MetadataError",
      Effect.fnUntraced(function* () {
        yield* Effect.logDebug("No PEP 723 metadata.");
        return ["marimo", "pyzmq"];
      }),
    ),
  );
