import * as semver from "@std/semver";
import type * as py from "@vscode/python-extension";
import { Brand, Cause, Effect, Option, Redacted, Stream } from "effect";
import type * as vscode from "vscode";

import { unreachable } from "../assert.ts";
import { Config } from "../config/Config.ts";
import { extractExecuteCodeRequest } from "../lib/extractExecuteCodeRequest.ts";
import { extractPythonError } from "../lib/extractPythonError.ts";
import { formatControllerLabel } from "../lib/formatControllerLabel.ts";
import { installPackages } from "../lib/installPackages.ts";
import { isProblematicFilename } from "../lib/validateNotebookFilename.ts";
import { NotebookSerializer } from "../notebook/NotebookSerializer.ts";
import { Constants } from "../platform/Constants.ts";
import { VsCode } from "../platform/VsCode.ts";
import { EnvironmentValidator } from "../python/EnvironmentValidator.ts";
import { findVenvPath } from "../python/findVenvPath.ts";
import { Uv } from "../python/Uv.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";
import type { CellOutputReplay } from "../schemas/Models.gen.ts";
import type { Drive } from "./CellExecutions.ts";
import { makeControllerSelectionChanges } from "./ControllerSelectionChanges.ts";
import { NotebookRuntime } from "./NotebookRuntime.ts";
import { VsCodeCellDrive } from "./VsCodeCellDrive.ts";
import { VsCodeNotebookOutputPresenter } from "./VsCodeNotebookOutputPresenter.ts";

const NotebookControllerId = Brand.nominal<NotebookControllerId>();
export type NotebookControllerId = Brand.Branded<string, "ControllerId">;

export const createPythonController = Effect.fn("createPythonController")(
  function* (options: {
    id: NotebookControllerId;
    label: string;
    env: py.Environment;
  }) {
    const uv = yield* Uv;
    const code = yield* VsCode;
    const cellDrive = yield* VsCodeCellDrive;
    const outputPresenter = yield* VsCodeNotebookOutputPresenter;
    const config = yield* Config;
    const notebooks = yield* NotebookRuntime;
    const validator = yield* EnvironmentValidator;
    const serializer = yield* NotebookSerializer;
    const { LanguageId } = yield* Constants;
    const runPromise = Effect.runPromiseWith(yield* Effect.context());

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
            yield* Effect.logWarning("Empty execution request");
            return;
          }

          const validation = isProblematicFilename(rawNotebook.uri);
          if (validation.problematic) {
            yield* code.window.showErrorMessage(validation.message, {
              modal: true,
            });
            return;
          }

          const validEnv = yield* validator.validate(options.env);

          const documentHandle = yield* notebooks.forDocument(rawNotebook);
          yield* documentHandle.executeCells(
            request.value,
            validEnv.executable,
          );
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
            NotebookFileRootError: Effect.fn(function* (error) {
              yield* Effect.logError(error.message).pipe(
                Effect.annotateLogs({ configuredValue: error.configuredValue }),
              );
              yield* code.window.showErrorMessage(error.message, {
                modal: true,
              });
            }),
            NoActiveKernelError: Effect.fn(function* () {
              yield* code.window.showErrorMessage(
                "The notebook was closed before its kernel could start.",
                { modal: true },
              );
            }),
            MarimoCommandError: Effect.fn(function* (error) {
              yield* Effect.logError("Failed to execute command").pipe(
                Effect.annotateLogs({
                  cause: Cause.fail(error),
                  command: Redacted.value(error.command).command,
                }),
              );
              const detail = extractPythonError(error.cause);
              yield* code.window.showErrorMessage(
                Option.isSome(detail)
                  ? `Failed to execute marimo command:\n\n${detail.value}`
                  : "Failed to execute marimo command. Please check the logs for details.",
                { modal: true },
              );
            }),
            EnvironmentInspectionError: Effect.fn(function* (error) {
              yield* Effect.logError("Python venv check failed").pipe(
                Effect.annotateLogs({
                  cause: Cause.fail(error),
                  pythonPath: error.env.path,
                  stdout: error.stdout,
                  stderr: error.stderr,
                }),
              );

              if (error.cause?._tag === "InvalidExecutableError") {
                yield* code.window.showErrorMessage(
                  `Python executable does not exist for env: ${error.env.path}.`,
                  { modal: true },
                );
              } else {
                const stderrSnippet = error.stderr
                  ? `\n\nstderr:\n${truncate(error.stderr.trim(), 500)}`
                  : "";
                yield* code.window.showErrorMessage(
                  `Failed to check dependencies in ${formatControllerLabel(code, options.env)}.\n\n` +
                    `Python path: ${error.env.path}` +
                    stderrSnippet,
                  { modal: true },
                );
              }
            }),
            EnvironmentRequirementError: Effect.fn(function* (error) {
              yield* Effect.logWarning("Environment requirements not met").pipe(
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
              const uvEnabled = yield* config.uv.enabled;
              const canInstallWithUv = uvEnabled && Option.isSome(venv);

              if (canInstallWithUv) {
                const msg =
                  `${formatControllerLabel(code, options.env)} cannot run the marimo kernel:\n\n` +
                  messages.join("\n") +
                  `\n\nPackages are missing or outdated.\n\nInstall with uv?`;

                const choice = yield* code.window.showErrorMessage(msg, {
                  modal: true,
                  items: ["Yes"],
                });
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
            }),
          }),
        ),
      );

    // Set up interrupt handler
    controller.interruptHandler = (rawNotebook) =>
      runPromise(
        Effect.gen(function* () {
          const notebook = MarimoNotebookDocument.from(rawNotebook);
          const handle = yield* notebooks.forNotebook(notebook.id);
          yield* handle.interrupt;
        }).pipe(
          Effect.withSpan("PythonController.interrupt", {
            attributes: {
              controllerId: controller.id,
              notebook: rawNotebook.uri.toString(),
            },
          }),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logError("Failed to interrupt execution").pipe(
                Effect.annotateLogs({ cause }),
              );
              yield* code.window.showErrorMessage(
                "Failed to interrupt execution. Please check the logs for details.",
              );
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

    return new PythonController(
      controller,
      options.env.path,
      selectedNotebookChanges,
      (notebook) =>
        cellDrive.bind({
          notebook,
          controller: {
            createNotebookCellExecution: (cell) =>
              controller.createNotebookCellExecution(cell.rawNotebookCell),
          },
        }),
      (notebook, replays) =>
        outputPresenter.present(
          notebook,
          {
            createNotebookCellExecution: (cell) =>
              controller.createNotebookCellExecution(cell),
          },
          replays,
        ),
    );
  },
);

export class PythonController {
  readonly _tag = "PythonController";
  #inner: Omit<vscode.NotebookController, "dispose">;
  readonly drive: (notebook: MarimoNotebookDocument) => Drive;
  readonly presentOutputs: (
    notebook: MarimoNotebookDocument,
    replays: ReadonlyArray<CellOutputReplay>,
  ) => Effect.Effect<void>;
  /** The python interpreter this controller's environment runs on. */
  executable: string;
  /**
   * Selection events buffered from the moment the controller was created
   * (see createPythonController). Backed by a queue, so a single consumer
   * receives every event, including ones fired before it subscribed.
   */
  readonly selectedNotebookChanges: Stream.Stream<{
    notebook: vscode.NotebookDocument;
    selected: boolean;
  }>;
  constructor(
    inner: Omit<vscode.NotebookController, "dispose">,
    executable: string,
    selectedNotebookChanges: Stream.Stream<{
      notebook: vscode.NotebookDocument;
      selected: boolean;
    }>,
    drive: (notebook: MarimoNotebookDocument) => Drive,
    presentOutputs: (
      notebook: MarimoNotebookDocument,
      replays: ReadonlyArray<CellOutputReplay>,
    ) => Effect.Effect<void>,
  ) {
    this.#inner = inner;
    this.executable = executable;
    this.selectedNotebookChanges = selectedNotebookChanges;
    this.drive = drive;
    this.presentOutputs = presentOutputs;
  }
  static getId(env: py.Environment) {
    return NotebookControllerId(`marimo-${env.path}`);
  }
  get id(): NotebookControllerId {
    // SAFETY: `this.#inner` is constructed with an id produced by the static
    // getId() helper below, which runs the string through the
    // NotebookControllerId brand constructor.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return this.#inner.id as NotebookControllerId;
  }
  mutateDescription(description: string) {
    return Effect.sync(() => {
      this.#inner.description = description;
      return this;
    });
  }
  resolveExecutable(_notebook: MarimoNotebookDocument) {
    return Effect.succeed(this.executable);
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

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}…`;
}
