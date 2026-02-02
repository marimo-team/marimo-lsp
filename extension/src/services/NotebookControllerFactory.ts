import * as semver from "@std/semver";
import type * as py from "@vscode/python-extension";
import { Brand, Effect, Option, Runtime, Stream } from "effect";
import type * as vscode from "vscode";
import { unreachable } from "../assert.ts";
import { type MarimoNotebookCell, MarimoNotebookDocument } from "../schemas.ts";
import { Constants } from "../services/Constants.ts";
import { extractExecuteCodeRequest } from "../utils/extractExecuteCodeRequest.ts";
import { findVenvPath } from "../utils/findVenvPath.ts";
import { formatControllerLabel } from "../utils/formatControllerLabel.ts";
import { installPackages } from "../utils/installPackages.ts";
import { Config } from "./Config.ts";
import { EnvironmentValidator } from "./EnvironmentValidator.ts";
import { LanguageClient } from "./LanguageClient.ts";
import { NotebookSerializer } from "./NotebookSerializer.ts";
import { Uv } from "./Uv.ts";
import { VsCode } from "./VsCode.ts";

const NotebookControllerId = Brand.nominal<NotebookControllerId>();
export type NotebookControllerId = Brand.Branded<string, "ControllerId">;

export class NotebookControllerFactory extends Effect.Service<NotebookControllerFactory>()(
  "NotebookControllerFactory",
  {
    dependencies: [
      Uv.Default,
      Config.Default,
      Constants.Default,
      EnvironmentValidator.Default,
      NotebookSerializer.Default,
    ],
    scoped: Effect.gen(function* () {
      const uv = yield* Uv;
      const code = yield* VsCode;
      const config = yield* Config;
      const marimo = yield* LanguageClient;
      const validator = yield* EnvironmentValidator;
      const serializer = yield* NotebookSerializer;
      const { LanguageId } = yield* Constants;

      const runtime = yield* Effect.runtime();
      const runPromise = Runtime.runPromise(runtime);

      return {
        createNotebookController: Effect.fn(
          "NotebookControllerFactory.createController",
        )(function* (options: {
          id: NotebookControllerId;
          label: string;
          env: py.Environment;
        }) {
          yield* Effect.annotateCurrentSpan("controllerId", options.id);
          const controller = yield* code.notebooks.createNotebookController(
            options.id,
            serializer.notebookType,
            options.label,
          );

          // Add metadata
          controller.supportedLanguages = [LanguageId.Python, LanguageId.Sql];
          controller.description = options.env.path;

          // Set up execution handler
          controller.executeHandler = (rawCells, rawNotebook, controller) =>
            runPromise(
              Effect.gen(function* () {
                const request = extractExecuteCodeRequest(rawCells, LanguageId);
                if (Option.isNone(request)) {
                  return yield* Effect.logWarning("Empty execution request");
                }

                const notebook = MarimoNotebookDocument.from(rawNotebook);
                const validEnv = yield* validator.validate(options.env);

                yield* marimo.executeCommand({
                  command: "marimo.api",
                  params: {
                    method: "execute-cells",
                    params: {
                      notebookUri: notebook.id,
                      executable: validEnv.executable,
                      inner: request.value,
                    },
                  },
                });
              }).pipe(
                Effect.withSpan("PythonController.execute", {
                  attributes: {
                    controllerId: controller.id,
                    cellCount: rawCells.length,
                    notebook: rawNotebook.uri.toString(),
                  },
                }),
                // Known exceptions
                Effect.catchTags({
                  ExecuteCommandError: Effect.fnUntraced(function* (error) {
                    yield* Effect.logError(
                      "Failed to execute command",
                      error,
                    ).pipe(
                      Effect.annotateLogs({
                        command: error.command.command,
                      }),
                    );
                    yield* code.window.showErrorMessage(
                      "Failed to execute marimo command. Please check the logs for details.",
                      { modal: true },
                    );
                  }),
                  EnvironmentInspectionError: Effect.fnUntraced(
                    function* (error) {
                      yield* Effect.logError("Python venv check failed", error);

                      if (error.cause?._tag === "InvalidExecutableError") {
                        yield* code.window.showErrorMessage(
                          `Python executable does not exist for env: ${error.env.path}.`,
                          { modal: true },
                        );
                      } else {
                        yield* code.window.showErrorMessage(
                          `Failed to check dependencies in ${formatControllerLabel(code, options.env)}.\n\n` +
                            `Python path: ${error.env.path}`,
                          { modal: true },
                        );
                      }
                    },
                  ),
                  EnvironmentRequirementError: Effect.fnUntraced(
                    function* (error) {
                      yield* Effect.logWarning(
                        "Environment requirements not met",
                      ).pipe(
                        Effect.annotateLogs({
                          pythonPath: error.env.path,
                          diagnostics: error.diagnostics,
                        }),
                      );
                      const messages = error.diagnostics.map((d) => {
                        switch (d.kind) {
                          case "missing":
                            return `• ${d.package}: not installed`;
                          case "outdated":
                            return `• ${d.package}: v${semver.format(d.currentVersion)} (requires >=v${semver.format(d.requiredVersion)})`;
                          case "unknown":
                            return `• ${d.package}: unable to detect`;
                          default:
                            return unreachable(d);
                        }
                      });

                      // Only prompt to install if uv is enabled and we have a venv
                      // Non-venv environments (pixi, conda, bazel, global) don't have pyvenv.cfg
                      // so uv can't install packages there
                      const venv = findVenvPath(options.env.path);
                      const canInstallWithUv =
                        config.uv.enabled && Option.isSome(venv);

                      if (canInstallWithUv) {
                        const msg =
                          `${formatControllerLabel(code, options.env)} cannot run the marimo kernel:\n\n` +
                          messages.join("\n") +
                          `\n\nPackages are missing or outdated.\n\nInstall with uv?`;

                        const choice = yield* code.window.showErrorMessage(
                          msg,
                          { modal: true, items: ["Yes"] },
                        );
                        if (!choice) {
                          return;
                        }
                        const packages = error.diagnostics.map((d) =>
                          d.kind === "outdated"
                            ? `${d.package}>=${semver.format(d.requiredVersion)}`
                            : d.package,
                        );
                        yield* installPackages(packages, {
                          venvPath: venv.value,
                        }).pipe(
                          Effect.provideService(VsCode, code),
                          Effect.provideService(Uv, uv),
                        );
                      } else {
                        const msg =
                          `${formatControllerLabel(code, options.env)} cannot run the marimo kernel:\n\n` +
                          messages.join("\n") +
                          `\n\nPlease install or update the missing packages.`;

                        yield* code.window.showErrorMessage(msg, {
                          modal: true,
                        });
                      }
                    },
                  ),
                }),
              ),
            );

          // Set up interrupt handler
          controller.interruptHandler = (rawNotebook) =>
            runPromise(
              Effect.gen(function* () {
                const notebook = MarimoNotebookDocument.from(rawNotebook);
                yield* marimo.executeCommand({
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
                Effect.withSpan("PythonController.interrupt", {
                  attributes: {
                    controllerId: controller.id,
                    notebook: rawNotebook.uri.toString(),
                  },
                }),
                Effect.catchAllCause((cause) =>
                  Effect.gen(function* () {
                    yield* Effect.logError(
                      "Failed to interrupt execution",
                      cause,
                    );
                    yield* code.window.showErrorMessage(
                      "Failed to interrupt execution. Please check the logs for details.",
                    );
                  }),
                ),
              ),
            );

          return new PythonController(controller, options.env.path);
        }),
      };
    }),
  },
) {}

export class PythonController {
  readonly _tag = "PythonController";
  #inner: Omit<vscode.NotebookController, "dispose">;
  executable: string;
  constructor(
    inner: Omit<vscode.NotebookController, "dispose">,
    executable: string,
  ) {
    this.#inner = inner;
    this.executable = executable;
  }
  static getId(env: py.Environment) {
    return NotebookControllerId(`marimo-${env.path}`);
  }
  get id(): NotebookControllerId {
    return this.#inner.id as NotebookControllerId;
  }
  mutateDescription(description: string) {
    return Effect.sync(() => {
      this.#inner.description = description;
      return this;
    });
  }
  createNotebookCellExecution(cell: MarimoNotebookCell) {
    return this.#inner.createNotebookCellExecution(cell.rawNotebookCell);
  }
  selectedNotebookChanges() {
    return Stream.asyncPush<{
      notebook: vscode.NotebookDocument;
      selected: boolean;
    }>((emit) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          this.#inner.onDidChangeSelectedNotebooks((e) => emit.single(e)),
        ),
        (disposable) => Effect.sync(() => disposable.dispose()),
      ),
    );
  }
  updateNotebookAffinity(
    notebook: vscode.NotebookDocument,
    affinity: vscode.NotebookControllerAffinity,
  ) {
    return Effect.sync(() => {
      this.#inner.updateNotebookAffinity(notebook, affinity);
    });
  }
}
