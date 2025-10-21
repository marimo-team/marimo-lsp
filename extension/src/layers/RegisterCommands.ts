import * as NodePath from "node:path";
import { Cause, Chunk, Effect, Either, Layer, Option } from "effect";
import { NOTEBOOK_TYPE } from "../constants.ts";
import { decodeCellMetadata, isStaleCellMetadata } from "../schemas.ts";
import { ConfigContextManager } from "../services/config/ConfigContextManager.ts";
import { MarimoConfigurationService } from "../services/config/MarimoConfigurationService.ts";
import { ExecutionRegistry } from "../services/ExecutionRegistry.ts";
import { GitHubClient } from "../services/GitHubClient.ts";
import { LanguageClient } from "../services/LanguageClient.ts";
import { NotebookSerializer } from "../services/NotebookSerializer.ts";
import { OutputChannel } from "../services/OutputChannel.ts";
import { VsCode } from "../services/VsCode.ts";
import { getNotebookUri } from "../types.ts";
import { showErrorAndPromptLogs } from "../utils/showErrorAndPromptLogs.ts";

/**
 * Registers VS Code commands for the marimo extension.
 */
export const RegisterCommandsLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const gh = yield* GitHubClient;
    const code = yield* VsCode;
    const client = yield* LanguageClient;
    const channel = yield* OutputChannel;
    const executions = yield* ExecutionRegistry;
    const serializer = yield* NotebookSerializer;
    const configService = yield* MarimoConfigurationService;
    const configContextManager = yield* ConfigContextManager;

    yield* code.commands.registerCommand(
      "marimo.newMarimoNotebook",
      newMarimoNotebook({ code, serializer }),
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
  }),
);

const newMarimoNotebook = ({
  code,
  serializer,
}: {
  code: VsCode;
  serializer: NotebookSerializer;
}) =>
  Effect.gen(function* () {
    const doc = yield* code.workspace.openUntitledNotebookDocument(
      serializer.notebookType,
      new code.NotebookData([
        new code.NotebookCellData(code.NotebookCellKind.Code, "", "python"),
      ]),
    );

    yield* code.window.showNotebookDocument(doc);

    yield* Effect.logInfo("Created new marimo notebook").pipe(
      Effect.annotateLogs({
        uri: doc.uri.toString(),
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
