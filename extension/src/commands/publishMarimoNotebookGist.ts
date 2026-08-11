import * as NodePath from "node:path";

import { Cause, Effect, flow, Option, Result, Schema } from "effect";

import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { MarimoClient } from "../lsp/MarimoClient.ts";
import { NotebookSerializer } from "../notebook/NotebookSerializer.ts";
import { GitHubClient } from "../platform/GitHubClient.ts";
import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";

export const publishMarimoNotebookGist = Effect.fn(
  "command.publishMarimoNotebookGist",
)(
  function* (notebook: MarimoNotebookDocument) {
    const code = yield* VsCode;
    const gh = yield* GitHubClient;
    const marimo = yield* MarimoClient;
    const serializer = yield* NotebookSerializer;

    const choice = yield* code.window.showQuickPick(["Public", "Secret"], {
      placeHolder: "Gist visibility",
    });

    if (Option.isNone(choice)) {
      // cancelled
      return;
    }

    const bytes = yield* serializer.serializeEffect({
      metadata: notebook.rawMetadata,
      cells: notebook
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

    const filename = NodePath.basename(notebook.uri.path);
    const ipynbFilename = filename.replace(/\.py$/, ".ipynb");
    const files: Record<string, { content: string }> = {
      [filename]: {
        content: new TextDecoder().decode(bytes),
      },
    };

    // Try to export ipynb with outputs for GitHub rendering
    const ipynbResult = yield* marimo
      .exportAsIpynb({
        notebookUri: notebook.id,
        inner: {},
      })
      .pipe(
        Effect.andThen(Schema.decodeUnknownEffect(Schema.String)),
        Effect.result,
      );

    if (Result.isSuccess(ipynbResult)) {
      files[ipynbFilename] = { content: ipynbResult.success };
    } else {
      yield* Effect.logWarning(
        "Could not export ipynb for gist — publishing .py only",
      ).pipe(
        Effect.annotateLogs({
          cause: Cause.fail(ipynbResult.failure),
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
    if (Result.isSuccess(ipynbResult)) {
      const ipynb = JSON.parse(ipynbResult.success);
      ipynb.cells.unshift(createMolabMarkdownBadgeCell(gist));
      yield* gh.Gists.update({
        params: { id: gist.id },
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
        Result.getOrThrow(code.utils.parseUri(gist.html_url)),
      );
    }
  },
  flow(
    Effect.tapCause(Effect.logError),
    Effect.catchTag("HttpClientError", (error) =>
      showErrorAndPromptLogs(
        `Failed to create Gist: ${error.reason.description ?? "Network error"}.`,
      ),
    ),
    Effect.catchCause((cause) =>
      showErrorAndPromptLogs(
        `Failed to create Gist: ${Option.fromNullishOr(
          cause.reasons.find(Cause.isFailReason),
        ).pipe(
          Option.map((reason) => reason.error.name),
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
