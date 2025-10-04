import * as semver from "@std/semver";
import type * as py from "@vscode/python-extension";
import { Brand, Data, Effect, FiberSet, Option } from "effect";
import type * as vscode from "vscode";
import { unreachable } from "../assert.ts";
import { getNotebookUri } from "../types.ts";
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
      VsCode.Default,
      Config.Default,
      LanguageClient.Default,
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

      const runPromise = yield* FiberSet.makeRuntimePromise();

      return {
        createNotebookController: Effect.fnUntraced(function* (options: {
          id: NotebookControllerId;
          label: string;
          env: py.Environment;
        }) {
          const controller = yield* code.notebooks.createNotebookController(
            options.id,
            serializer.notebookType,
            options.label,
          );

          // Add metadata
          controller.supportedLanguages = ["python"];
          controller.description = options.env.path;

          // Set up execution handler
          controller.executeHandler = (cells, notebook, controller) =>
            runPromise(
              Effect.gen(function* () {
                yield* Effect.logInfo("Running cells").pipe(
                  Effect.annotateLogs({
                    controller: controller.id,
                    cellCount: cells.length,
                    notebook: notebook.uri.toString(),
                  }),
                );
                const validEnv = yield* validator.validate(options.env);
                yield* marimo.executeCommand({
                  command: "marimo.run",
                  params: {
                    notebookUri: getNotebookUri(notebook),
                    executable: validEnv.executable,
                    inner: {
                      cellIds: cells.map((cell) =>
                        cell.document.uri.toString(),
                      ),
                      codes: cells.map((cell) => cell.document.getText()),
                    },
                  },
                });
              }).pipe(
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

                      // Only prompt to install if uv is enabled
                      if (config.uv.enabled) {
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
                        const venv = findVenvPath(options.env.path);
                        if (Option.isNone(venv)) {
                          yield* code.window.showWarningMessage(
                            `Package install failed. No venv found for ${options.env.path}`,
                          );
                          return;
                        }
                        yield* installPackages(venv.value, packages, {
                          uv,
                          code,
                        });
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
          controller.interruptHandler = (notebook) =>
            runPromise(
              Effect.gen(function* () {
                yield* Effect.logInfo("Interrupting execution").pipe(
                  Effect.annotateLogs({
                    controllerId: controller.id,
                    notebook: notebook.uri.toString(),
                  }),
                );
                yield* marimo.executeCommand({
                  command: "marimo.interrupt",
                  params: {
                    notebookUri: getNotebookUri(notebook),
                    inner: {},
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

          return new NotebookController({
            _inner: controller,
            _runPromise: runPromise,
            env: options.env,
          });
        }),
      };
    }),
  },
) {}

export class NotebookController extends Data.TaggedClass("NotebookController")<{
  readonly _inner: vscode.NotebookController;
  readonly _runPromise: (
    effect: Effect.Effect<void, never, never>,
  ) => Promise<void>;
  readonly env: py.Environment;
}> {
  static getId(env: py.Environment) {
    return NotebookControllerId(`marimo-${env.path}`);
  }
  get id(): NotebookControllerId {
    return this._inner.id as NotebookControllerId;
  }
  mutateDescription(description: string) {
    this._inner.description = description;
    return this;
  }
  createNotebookCellExecution(cell: vscode.NotebookCell) {
    return this._inner.createNotebookCellExecution(cell);
  }
  onDidChangeSelectedNotebooks(
    listener: (options: {
      readonly notebook: vscode.NotebookDocument;
      readonly selected: boolean;
    }) => Effect.Effect<void, never, never>,
  ) {
    return Effect.acquireRelease(
      Effect.sync(() =>
        this._inner.onDidChangeSelectedNotebooks((e) =>
          this._runPromise(listener(e)),
        ),
      ),
      (disposable) => Effect.sync(() => disposable.dispose()),
    );
  }
}
