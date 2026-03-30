import * as NodePath from "node:path";

import { Cause, Chunk, Effect, Either, flow, Schema, Option } from "effect";

import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { LanguageClient } from "../lsp/LanguageClient.ts";
import { NotebookSerializer } from "../notebook/NotebookSerializer.ts";
import { GitHubClient } from "../platform/GitHubClient.ts";
import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";

export const publishMarimoNotebookGist = Effect.fn(
  "command.publishMarimoNotebookGist",
)(
  function* () {
    const code = yield* VsCode;
    const gh = yield* GitHubClient;
    const client = yield* LanguageClient;
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
    const ipynbFilename = filename.replace(/\.py$/, ".ipynb");
    const files: Record<string, { content: string }> = {
      [filename]: {
        content: new TextDecoder().decode(bytes),
      },
    };

    // Try to export ipynb with outputs for GitHub rendering
    const ipynbResult = yield* client
      .executeCommand({
        command: "marimo.api",
        params: {
          method: "export-as-ipynb",
          params: {
            notebookUri: notebook.value.id,
            inner: {},
          },
        },
      })
      .pipe(Effect.andThen(Schema.decodeUnknown(Schema.String)), Effect.either);

    if (Either.isRight(ipynbResult)) {
      files[ipynbFilename] = { content: ipynbResult.right };
    } else {
      yield* Effect.logWarning(
        "Could not export ipynb for gist — publishing .py only",
      ).pipe(
        Effect.annotateLogs({
          cause: Cause.fail(ipynbResult.left),
        }),
      );
    }

    const gist = yield* gh.Gists.create({
      payload: {
        public: choice.value === "Public",
        files,
      },
    });

    yield* Effect.logInfo("Published gist").pipe(Effect.annotateLogs({ gist }));

    // Update the gist with a molab badge in the ipynb
    if (Either.isRight(ipynbResult)) {
      const ipynb = JSON.parse(ipynbResult.right);
      ipynb.cells.unshift(createMolabMarkdownBadgeCell(gist));
      yield* gh.Gists.update({
        path: { id: gist.id },
        payload: {
          files: {
            [ipynbFilename]: { content: JSON.stringify(ipynb, null, 2) },
          },
        },
      });
    }

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

function createMolabMarkdownBadgeCell(gist: { html_url: string }) {
  const molabHref = `https://molab.marimo.io/github/${gist.html_url.replace(/^https?:\/\//, "")}`;
  return {
    cell_type: "markdown",
    metadata: {},
    source: [
      `[![Open in molab](https://molab.marimo.io/molab-shield.svg)](${molabHref})`,
    ],
  };
}
