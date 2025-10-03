import * as NodePath from "node:path";
import { Cause, Chunk, Effect, Either, Layer, Option } from "effect";
import { GitHubClient } from "../services/GitHubClient.ts";
import { LanguageClient } from "../services/LanguageClient.ts";
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
      "marimo.createGist",
      createGist({ code, serializer, gh, channel }),
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
    const doc = yield* code.workspace.use((api) =>
      api.openNotebookDocument(
        serializer.notebookType,
        new code.NotebookData([
          new code.NotebookCellData(code.NotebookCellKind.Code, "", "python"),
        ]),
      ),
    );
    yield* code.window.use((api) => api.showNotebookDocument(doc));
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
    const notebook = code.window
      .getActiveNotebookEditor()
      .pipe(
        Option.filterMap((editor) =>
          serializer.isMarimoNotebookDocument(editor.notebook)
            ? Option.some(editor.notebook)
            : Option.none(),
        ),
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

    const choice = yield* code.window.useInfallible((api) =>
      api.showQuickPick(["Public", "Secret"], {
        placeHolder: "Gist visibility",
      }),
    );

    if (!choice) {
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
        public: choice === "Public",
        files: {
          [filename]: {
            content: new TextDecoder().decode(bytes),
          },
        },
      },
    });

    yield* Effect.logInfo(gist);

    const selection = yield* code.window.useInfallible((api) =>
      api.showInformationMessage(`Published Gist at ${gist.html_url}`, "Open"),
    );

    if (selection === "Open") {
      // Open the URL
      yield* code.env.useInfallible((api) =>
        api.openExternal(Either.getOrThrow(code.utils.parseUri(gist.html_url))),
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
