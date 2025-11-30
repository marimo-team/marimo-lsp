import * as NodePath from "node:path";
import {
  Cause,
  Chunk,
  Effect,
  Either,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";
import { NOTEBOOK_TYPE, SETUP_CELL_NAME } from "../constants.ts";
import {
  decodeCellMetadata,
  encodeCellMetadata,
  isStaleCellMetadata,
} from "../schemas.ts";
import { ControllerRegistry } from "../services/ControllerRegistry.ts";
import { CustomPythonPathService } from "../services/CustomPythonPathService.ts";
import { ConfigContextManager } from "../services/config/ConfigContextManager.ts";
import { MarimoConfigurationService } from "../services/config/MarimoConfigurationService.ts";
import { ExecutionRegistry } from "../services/ExecutionRegistry.ts";
import { GitHubClient } from "../services/GitHubClient.ts";
import { HealthService } from "../services/HealthService.ts";
import { LanguageClient } from "../services/LanguageClient.ts";
import { NotebookSerializer } from "../services/NotebookSerializer.ts";
import { OutputChannel } from "../services/OutputChannel.ts";
import { PythonExtension } from "../services/PythonExtension.ts";
import { type ITelemetry, Telemetry } from "../services/Telemetry.ts";
import { Uv } from "../services/Uv.ts";
import { VsCode } from "../services/VsCode.ts";
import { getNotebookUri } from "../types.ts";
import { Links } from "../utils/links.ts";
import { showErrorAndPromptLogs } from "../utils/showErrorAndPromptLogs.ts";

/**
 * Registers VS Code commands for the marimo extension.
 */
export const RegisterCommandsLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const gh = yield* GitHubClient;
    const py = yield* PythonExtension;
    const uv = yield* Uv;
    const code = yield* VsCode;
    const client = yield* LanguageClient;
    const channel = yield* OutputChannel;
    const executions = yield* ExecutionRegistry;
    const serializer = yield* NotebookSerializer;
    const configService = yield* MarimoConfigurationService;
    const configContextManager = yield* ConfigContextManager;
    const controllers = yield* ControllerRegistry;
    const healthService = yield* HealthService;
    const telemetry = yield* Telemetry;
    const customPythonPathService = yield* CustomPythonPathService;

    yield* code.commands.registerCommand(
      "marimo.newMarimoNotebook",
      newMarimoNotebook({ code, serializer, telemetry }),
    );

    yield* code.commands.registerCommand(
      "marimo.createSetupCell",
      createSetupCell({ code, serializer }),
    );

    yield* code.commands.registerCommand(
      "marimo.openAsMarimoNotebook",
      openAsMarimoNotebook({ code }),
    );

    yield* code.commands.registerCommand(
      "marimo.publishMarimoNotebookGist",
      createGist({ code, serializer, gh, channel }),
    );

    yield* code.commands.registerCommand(
      "marimo.publishMarimoNotebook",
      Effect.gen(function* () {
        const choice = yield* code.window.showQuickPickItems([
          {
            label: "GitHub Gist",
            detail: "Publish marimo notebook as a GitHub Gist",
          },
        ]);
        if (Option.isNone(choice)) {
          return choice;
        }
        if (choice.value.label === "GitHub Gist") {
          yield* code.commands.executeCommand(
            "marimo.publishMarimoNotebookGist",
          );
        }
      }),
    );

    yield* code.commands.registerCommand(
      "marimo.runStale",
      runStale({ code, serializer, channel }),
    );

    yield* code.commands.registerCommand(
      "marimo.toggleOnCellChangeAutoRun",
      toggleOnCellChange({
        code,
        serializer,
        channel,
        configService,
        configContextManager,
      }),
    );

    yield* code.commands.registerCommand(
      "marimo.toggleOnCellChangeLazy",
      toggleOnCellChange({
        code,
        serializer,
        channel,
        configService,
        configContextManager,
      }),
    );

    yield* code.commands.registerCommand(
      "marimo.restartKernel",
      Effect.gen(function* () {
        const editor = yield* code.window.getActiveNotebookEditor();
        if (Option.isNone(editor)) {
          yield* code.window.showInformationMessage(
            "No marimo notebook is currently open",
          );
          return;
        }

        yield* code.window.withProgress(
          {
            location: code.ProgressLocation.Window,
            title: "Restarting kernel",
            cancellable: true,
          },
          Effect.fnUntraced(function* (progress) {
            progress.report({ message: "Closing session..." });

            const result = yield* client
              .executeCommand({
                command: "marimo.api",
                params: {
                  method: "close_session",
                  params: {
                    notebookUri: getNotebookUri(editor.value.notebook),
                    inner: {},
                  },
                },
              })
              .pipe(Effect.either);

            if (Either.isLeft(result)) {
              yield* Effect.logFatal("Failed to restart kernel", result.left);
              yield* showErrorAndPromptLogs("Failed to restart kernel.", {
                channel,
                code,
              });
              return;
            }

            yield* executions.handleInterrupted(editor.value);

            // Clear all cell outputs by replacing each cell with fresh version
            const edit = new code.WorkspaceEdit();
            const cells = editor.value.notebook.getCells();
            const freshCells = cells.map((cell) => {
              const freshCell = new code.NotebookCellData(
                cell.kind,
                cell.document.getText(),
                cell.document.languageId,
              );
              freshCell.metadata = cell.metadata;
              return freshCell;
            });
            edit.set(editor.value.notebook.uri, [
              code.NotebookEdit.replaceCells(
                new code.NotebookRange(0, cells.length),
                freshCells,
              ),
            ]);
            yield* code.workspace.applyEdit(edit);

            progress.report({ message: "Kernel restarted." });
            yield* Effect.sleep("500 millis");
          }),
        );

        yield* code.window.showInformationMessage(
          "Kernel restarted successfully",
        );
      }),
    );

    yield* code.commands.registerCommand("marimo.restartLsp", client.restart);

    yield* code.commands.registerCommand(
      "marimo.showDiagnostics",
      healthService.showDiagnostics,
    );

    yield* code.commands.registerCommand(
      "marimo.reportIssue",
      Effect.gen(function* () {
        const uri = Either.getOrThrow(code.utils.parseUri(Links.issues));
        yield* code.env.openExternal(uri);
      }),
    );

    yield* code.commands.registerCommand(
      "marimo.exportStaticHTML",
      exportNotebookAsHTML({ code, client, channel, serializer }),
    );

    yield* code.commands.registerCommand(
      "marimo.updateActivePythonEnvironment",
      updateActivePythonEnvironment({ code, py, uv, controllers }),
    );

    yield* code.commands.registerCommand(
      "marimo.addCustomPythonPath",
      customPythonPathService.promptAdd.pipe(
        Effect.tap((result) =>
          Option.isSome(result)
            ? code.window.showInformationMessage(
                `Added custom Python path: ${result.value.nickname}`,
              )
            : Effect.void,
        ),
        Effect.catchAllCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("Failed to add custom Python path", cause);
            yield* showErrorAndPromptLogs(
              "Failed to add custom Python path. Check the logs for details.",
              { code, channel },
            );
          }),
        ),
      ),
    );

    yield* code.commands.registerCommand(
      "marimo.manageCustomPythonPaths",
      customPythonPathService.promptManage.pipe(
        Effect.catchAllCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError(
              "Failed to manage custom Python paths",
              cause,
            );
            yield* showErrorAndPromptLogs(
              "Failed to manage custom Python paths. Check the logs for details.",
              { code, channel },
            );
          }),
        ),
      ),
    );

    // Telemetry for commands
    const queue = yield* code.commands.subscribeToCommands();
    yield* Effect.forkScoped(
      queue.pipe(
        Stream.runForEach(
          Effect.fnUntraced(function* (result) {
            if (Either.isLeft(result)) {
              yield* telemetry.capture("executed_command", {
                command: result.left,
                success: false,
              });
            } else {
              yield* telemetry.capture("executed_command", {
                command: result.right,
                success: true,
              });
            }
          }),
        ),
        Stream.runDrain,
      ),
    );
  }),
);

const newMarimoNotebook = ({
  code,
  telemetry,
}: {
  code: VsCode;
  serializer: NotebookSerializer;
  telemetry: ITelemetry;
}) =>
  Effect.gen(function* () {
    const uri = yield* code.window.showSaveDialog({
      filters: { Python: ["py"] },
    });

    if (Option.isNone(uri)) {
      return;
    }

    yield* code.workspace.fs.writeFile(
      uri.value,
      new TextEncoder().encode(
        `import marimo

app = marimo.App()

@app.cell
def _():
    return
`.trim(),
      ),
    );

    const notebook = yield* code.workspace.openNotebookDocument(uri.value);
    yield* code.window.showNotebookDocument(notebook);

    yield* Effect.logInfo("Created new marimo notebook").pipe(
      Effect.annotateLogs({
        uri: notebook.uri.toString(),
      }),
    );

    yield* telemetry.capture("new_notebook_created");
  });

const createSetupCell = ({
  code,
  serializer,
}: {
  code: VsCode;
  serializer: NotebookSerializer;
}) =>
  Effect.gen(function* () {
    const notebook = Option.filterMap(
      yield* code.window.getActiveNotebookEditor(),
      (editor) =>
        serializer.isMarimoNotebookDocument(editor.notebook)
          ? Option.some(editor.notebook)
          : Option.none(),
    );

    if (Option.isNone(notebook)) {
      yield* code.window.showInformationMessage(
        "No marimo notebook is currently open",
      );
      return;
    }

    // Check if setup cell already exists
    const cells = notebook.value.getCells();
    const existing = cells.find((cell) => {
      const metadata = decodeCellMetadata(cell.metadata);
      return Option.isSome(metadata) && metadata.value.name === SETUP_CELL_NAME;
    });

    if (existing) {
      // Show message and focus on existing setup cell
      yield* code.window.showInformationMessage("Setup cell already exists");
      yield* code.window.showNotebookDocument(notebook.value, {
        selections: [
          new code.NotebookRange(existing.index, existing.index + 1),
        ],
      });
      return;
    }

    {
      // Create new setup cell at index 0
      const edit = new code.WorkspaceEdit();
      const cell = new code.NotebookCellData(
        code.NotebookCellKind.Code,
        "# Initialization code that runs before all other cells",
        "python",
      );
      cell.metadata = encodeCellMetadata({ name: SETUP_CELL_NAME });
      edit.set(notebook.value.uri, [code.NotebookEdit.insertCells(0, [cell])]);
      yield* code.workspace.applyEdit(edit);
    }

    yield* Effect.logInfo("Created setup cell").pipe(
      Effect.annotateLogs({
        notebook: notebook.value.uri.toString(),
      }),
    );
  });

const openAsMarimoNotebook = ({ code }: { code: VsCode }) =>
  Effect.gen(function* () {
    const editor = yield* code.window.getActiveTextEditor();

    if (Option.isNone(editor)) {
      yield* code.window.showInformationMessage(
        "No active file to open as notebook",
      );
      return;
    }

    // close previous editor
    yield* code.commands.executeCommand("workbench.action.closeActiveEditor");

    // Open as notebook
    yield* code.commands.executeCommand(
      "vscode.openWith",
      editor.value.document.uri,
      NOTEBOOK_TYPE,
    );

    yield* Effect.logInfo("Opened Python file as marimo notebook").pipe(
      Effect.annotateLogs({
        uri: editor.value.document.uri.toString(),
      }),
    );
  });

const createGist = ({
  code,
  serializer,
  gh,
  channel,
}: {
  code: VsCode;
  serializer: NotebookSerializer;
  gh: GitHubClient;
  channel: OutputChannel;
}) =>
  Effect.gen(function* () {
    const notebook = Option.filterMap(
      yield* code.window.getActiveNotebookEditor(),
      (editor) =>
        serializer.isMarimoNotebookDocument(editor.notebook)
          ? Option.some(editor.notebook)
          : Option.none(),
    );

    if (Option.isNone(notebook)) {
      yield* code.window.showWarningMessage(
        "Must have an open marimo notebook to publish Gist.",
      );
      return;
    }

    const choice = yield* code.window.showQuickPick(["Public", "Secret"], {
      placeHolder: "Gist visibility",
    });

    if (Option.isNone(choice)) {
      // cancelled
      return;
    }

    const bytes = yield* serializer.serializeEffect({
      metadata: notebook.value.metadata,
      cells: notebook.value
        .getCells()
        .map(
          (cell) =>
            new code.NotebookCellData(
              cell.kind,
              cell.document.getText(),
              cell.document.languageId,
            ),
        ),
    });

    const filename = NodePath.basename(notebook.value.uri.path);
    const gist = yield* gh.Gists.create({
      payload: {
        description: filename,
        public: choice.value === "Public",
        files: {
          [filename]: {
            content: new TextDecoder().decode(bytes),
          },
        },
      },
    });

    yield* Effect.logInfo(gist);

    const selection = yield* code.window.showInformationMessage(
      `Published Gist at ${gist.html_url}`,
      { items: ["Open"] },
    );

    if (Option.isSome(selection)) {
      // Open the URL
      yield* code.env.openExternal(
        Either.getOrThrow(code.utils.parseUri(gist.html_url)),
      );
    }
  }).pipe(
    Effect.tapErrorCause(Effect.logError),
    Effect.catchTag("RequestError", (error) =>
      showErrorAndPromptLogs(
        `Failed to create Gist: ${error.description ?? "Network error"}.`,
        { code, channel },
      ),
    ),
    Effect.catchAllCause((cause) =>
      showErrorAndPromptLogs(
        `Failed to create Gist: ${Cause.failures(cause).pipe(
          Chunk.get(0),
          Option.map((fail) => fail.name),
          Option.getOrElse(() => "UnknownError"),
        )}`,
        {
          code,
          channel,
        },
      ),
    ),
  );

const runStale = ({
  code,
  serializer,
  channel,
}: {
  code: VsCode;
  serializer: NotebookSerializer;
  channel: OutputChannel;
}) =>
  Effect.gen(function* () {
    const notebook = Option.filterMap(
      yield* code.window.getActiveNotebookEditor(),
      (editor) =>
        serializer.isMarimoNotebookDocument(editor.notebook)
          ? Option.some(editor.notebook)
          : Option.none(),
    );

    if (Option.isNone(notebook)) {
      yield* showErrorAndPromptLogs(
        "Must have an open marimo notebook to run stale cells.",
        { code, channel },
      );
      return;
    }

    const staleCells = notebook.value.getCells().filter((cell) => {
      const metadata = decodeCellMetadata(cell.metadata);
      return Option.isSome(metadata) && isStaleCellMetadata(metadata.value);
    });

    if (staleCells.length === 0) {
      yield* Effect.logInfo("No stale cells found");
      yield* code.window.showInformationMessage("No stale cells to run");
      return;
    }

    yield* Effect.logInfo("Running stale cells").pipe(
      Effect.annotateLogs({
        staleCount: staleCells.length,
        notebook: notebook.value.uri.toString(),
      }),
    );

    // Execute stale cells using VS Code's notebook execution command
    yield* code.commands.executeCommand("notebook.cell.execute", {
      ranges: staleCells.map((cell) => ({
        start: cell.index,
        end: cell.index + 1,
      })),
    });
  }).pipe(
    Effect.tapErrorCause(Effect.logError),
    Effect.catchAllCause(() =>
      showErrorAndPromptLogs("Failed to run stale cells.", { code, channel }),
    ),
  );

const toggleOnCellChange = ({
  code,
  serializer,
  channel,
  configService,
}: {
  code: VsCode;
  serializer: NotebookSerializer;
  channel: OutputChannel;
  configService: MarimoConfigurationService;
  configContextManager: ConfigContextManager;
}) =>
  Effect.gen(function* () {
    const notebook = Option.filterMap(
      yield* code.window.getActiveNotebookEditor(),
      (editor) =>
        serializer.isMarimoNotebookDocument(editor.notebook)
          ? Option.some(editor.notebook)
          : Option.none(),
    );

    if (Option.isNone(notebook)) {
      yield* showErrorAndPromptLogs(
        "Must have an open marimo notebook to toggle on cell change mode.",
        { code, channel },
      );
      return;
    }

    const notebookUri = getNotebookUri(notebook.value);

    // Fetch current configuration
    const config = yield* configService.getConfig(notebookUri);

    const currentMode = config.runtime?.on_cell_change ?? "autorun";

    // Show quick pick to select mode
    const choice = yield* code.window.showQuickPickItems([
      {
        label: "Auto-Run",
        description: currentMode === "autorun" ? "$(check) Current" : undefined,
        detail: "Automatically run cells when their ancestors change",
        value: "autorun" as const,
      },
      {
        label: "Lazy",
        description: currentMode === "lazy" ? "$(check) Current" : undefined,
        detail: "Mark cells stale when ancestors change, don't autorun",
        value: "lazy" as const,
      },
    ]);

    if (Option.isNone(choice)) {
      // User cancelled
      return;
    }

    const newMode = choice.value.value;

    if (newMode === currentMode) {
      yield* Effect.logInfo("Mode unchanged");
      return;
    }

    // Update configuration
    yield* Effect.logInfo("Updating on_cell_change mode").pipe(
      Effect.annotateLogs({
        notebook: notebookUri,
        from: currentMode,
        to: newMode,
      }),
    );

    yield* configService.updateConfig(notebookUri, {
      runtime: {
        on_cell_change: newMode,
      },
    });

    yield* code.window.showInformationMessage(
      `On cell change mode updated to: ${newMode === "autorun" ? "Auto-Run" : "Lazy"}`,
    );
  }).pipe(
    Effect.tapErrorCause(Effect.logError),
    Effect.catchAllCause(() =>
      showErrorAndPromptLogs("Failed to toggle on cell change mode.", {
        code,
        channel,
      }),
    ),
  );

const exportNotebookAsHTML = ({
  code,
  client,
  channel,
  serializer,
}: {
  code: VsCode;
  client: LanguageClient;
  channel: OutputChannel;
  serializer: NotebookSerializer;
}) =>
  Effect.gen(function* () {
    const notebook = Option.filterMap(
      yield* code.window.getActiveNotebookEditor(),
      (editor) =>
        serializer.isMarimoNotebookDocument(editor.notebook)
          ? Option.some(editor.notebook)
          : Option.none(),
    );

    if (Option.isNone(notebook)) {
      yield* code.window.showWarningMessage(
        "Must have an open marimo notebook to export as HTML.",
      );
      return;
    }

    const hasOutputs = notebook.value
      .getCells()
      .some((c) => c.outputs.length > 0);

    if (!hasOutputs) {
      yield* code.window.showWarningMessage(
        "Cannot export to HTML. Run the notebook to generate outputs first.",
      );
      return;
    }

    const notebookUri = getNotebookUri(notebook.value);

    // Ask user where to save the file
    const saveUri = yield* code.window.showSaveDialog({
      title: "Export notebook as HTML",
      filters: { HTML: ["html"] },
      defaultUri: code.utils
        .parseUri(notebook.value.uri.toString().replace(/\.py$/, ".html"))
        .pipe(Either.getOrUndefined),
    });

    if (Option.isNone(saveUri)) {
      // User cancelled
      return;
    }

    yield* code.window.withProgress(
      {
        location: code.ProgressLocation.Notification,
        title: "Exporting notebook as HTML",
        cancellable: false,
      },
      Effect.fnUntraced(function* () {
        // Call the LSP API to export the notebook
        const result = yield* client
          .executeCommand({
            command: "marimo.api",
            params: {
              method: "export_as_html",
              params: {
                notebookUri,
                inner: {
                  download: false,
                  files: [],
                  includeCode: true,
                  assetUrl: null,
                },
              },
            },
          })
          .pipe(
            Effect.andThen(Schema.decodeUnknown(Schema.String)),
            Effect.either,
          );

        if (Either.isLeft(result)) {
          yield* Effect.logFatal("Failed to export notebook", result.left);
          yield* showErrorAndPromptLogs("Failed to export notebook as HTML.", {
            channel,
            code,
          });
          return;
        }

        // Write the HTML to the file
        yield* code.workspace.fs.writeFile(
          saveUri.value,
          new TextEncoder().encode(result.right),
        );

        yield* Effect.logInfo("Exported notebook as HTML").pipe(
          Effect.annotateLogs({
            notebook: notebookUri,
            output: saveUri.value.fsPath,
          }),
        );
      }),
    );
  });

const updateActivePythonEnvironment = ({
  py,
  uv,
  code,
  controllers,
}: {
  py: PythonExtension;
  uv: Uv;
  code: VsCode;
  controllers: ControllerRegistry;
}) =>
  Effect.gen(function* () {
    const editor = yield* code.window.getActiveNotebookEditor();

    if (Option.isNone(editor)) {
      yield* code.window.showInformationMessage(
        "No marimo notebook is currently open",
      );
      return;
    }

    const controller = yield* controllers.getActiveController(
      editor.value.notebook,
    );

    if (Option.isNone(controller)) {
      yield* code.window.showInformationMessage(
        "No active controller for the current marimo notebook found. Please select a kernel first.",
      );
      return;
    }

    let executable: string;
    if (controller.value._tag === "VenvPythonController") {
      executable = controller.value.executable;
    } else {
      const script = editor.value.notebook.uri.fsPath;
      const venvResult = yield* uv.syncScript({ script }).pipe(Effect.either);

      if (Either.isLeft(venvResult)) {
        return yield* showErrorAndPromptLogs(
          "Failed to synchronize virtual environment for the current notebook.",
          { code, channel: uv.channel },
        );
      }

      executable = NodePath.join(venvResult.right, "bin", "python");
    }

    // update the active python environment
    yield* py.updateActiveEnvironmentPath(executable);

    // inform the user
    yield* code.window.showInformationMessage(
      `Active Python environment updated to: ${executable}`,
    );
  });
