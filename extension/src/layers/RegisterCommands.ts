import * as NodePath from "node:path";
import { Cause, Chunk, Effect, Either, Layer, Option } from "effect";
import { decodeCellMetadata, isStaleCellMetadata } from "../schemas.ts";
import { GitHubClient } from "../services/GitHubClient.ts";
import { NotebookSerializer } from "../services/NotebookSerializer.ts";
import { OutputChannel } from "../services/OutputChannel.ts";
import { VsCode } from "../services/VsCode.ts";
import { showErrorAndPromptLogs } from "../utils/showErrorAndPromptLogs.ts";

/**
 * Registers VS Code commands for the marimo extension.
 */
export const RegisterCommandsLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const gh = yield* GitHubClient;
    const code = yield* VsCode;
    const channel = yield* OutputChannel;
    const serializer = yield* NotebookSerializer;

    yield* code.commands.registerCommand(
      "marimo.newMarimoNotebook",
      newMarimoNotebook({ code, serializer }),
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
      yield* showErrorAndPromptLogs(
        "Must have an open marimo notebook to publish Gist.",
        {
          code,
          channel,
        },
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
      showErrorAndPromptLogs(
        "Failed to run stale cells. See marimo logs for details.",
        { code, channel },
      ),
    ),
  );
