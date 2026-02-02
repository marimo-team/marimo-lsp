import * as NodePath from "node:path";
import { Cause, Chunk, Effect, Either, flow, Option } from "effect";
import { MarimoNotebookDocument } from "../schemas.ts";
import { GitHubClient } from "../services/GitHubClient.ts";
import { NotebookSerializer } from "../services/NotebookSerializer.ts";
import { VsCode } from "../services/VsCode.ts";
import { showErrorAndPromptLogs } from "../utils/showErrorAndPromptLogs.ts";

export const publishMarimoNotebookGist = Effect.fn(
  "command.publishMarimoNotebookGist",
)(
  function* () {
    const code = yield* VsCode;
    const gh = yield* GitHubClient;
    const serializer = yield* NotebookSerializer;

    const notebook = Option.filterMap(
      yield* code.window.getActiveNotebookEditor(),
      (editor) => MarimoNotebookDocument.tryFrom(editor.notebook),
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
      metadata: notebook.value.rawMetadata,
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
  },
  flow(
    Effect.tapErrorCause(Effect.logError),
    Effect.catchTag("RequestError", (error) =>
      showErrorAndPromptLogs(
        `Failed to create Gist: ${error.description ?? "Network error"}.`,
      ),
    ),
    Effect.catchAllCause((cause) =>
      showErrorAndPromptLogs(
        `Failed to create Gist: ${Cause.failures(cause).pipe(
          Chunk.get(0),
          Option.map((fail) => fail.name),
          Option.getOrElse(() => "UnknownError"),
        )}`,
      ),
    ),
  ),
);
