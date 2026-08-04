import { Effect, Option } from "effect";

import type { NotebookToolbarContext } from "../commands.ts";
import type { AutoExportFormat } from "../features/AutoExport.ts";
import { getNotebookCommandEditor } from "../lib/getNotebookCommandEditor.ts";
import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";
import type { OwnedAppConfig } from "../schemas/Models.gen.ts";

const FORMATS = ["html", "ipynb", "markdown"] as const;

const isManagedFormat = (format: string): format is AutoExportFormat =>
  format === "html" || format === "ipynb" || format === "markdown";

export function mergeAutoDownloadFormats(
  current: OwnedAppConfig["auto_download"],
  selected: ReadonlyArray<AutoExportFormat>,
): OwnedAppConfig["auto_download"] {
  const retained = current.filter(
    (format) => !isManagedFormat(format) || selected.includes(format),
  );
  return [
    ...retained,
    ...FORMATS.filter(
      (format) => selected.includes(format) && !retained.includes(format),
    ),
  ];
}

export const configureAutoExport = Effect.fn("command.configureAutoExport")(
  function* (context?: NotebookToolbarContext) {
    const code = yield* VsCode;
    const notebook = Option.filterMap(
      yield* getNotebookCommandEditor(context),
      (editor) => MarimoNotebookDocument.tryFrom(editor.notebook),
    );

    if (Option.isNone(notebook)) {
      yield* code.window.showWarningMessage(
        "Open a marimo notebook to configure export formats.",
      );
      return;
    }

    const metadata = yield* notebook.value.parseMetadata();
    const current = metadata.appConfig.auto_download;
    const selected = yield* code.window.showQuickPickItemsMany(
      [
        {
          label: "HTML",
          detail: "Save a static HTML snapshot with current outputs",
          value: "html" as const,
          picked: current.includes("html"),
        },
        {
          label: "IPYNB",
          detail: "Save a Jupyter notebook with current outputs",
          value: "ipynb" as const,
          picked: current.includes("ipynb"),
        },
        {
          label: "Markdown",
          detail: "Save a Markdown representation of the notebook",
          value: "markdown" as const,
          picked: current.includes("markdown"),
        },
      ],
      {
        placeHolder: "Choose formats; saved under __marimo__",
        title: "Save copies automatically",
      },
    );
    if (Option.isNone(selected)) return;

    // The picker can stay open while another command updates notebook metadata.
    // Merge into the latest app config so those concurrent changes survive.
    const latestMetadata = yield* notebook.value.parseMetadata();
    const latest = latestMetadata.appConfig.auto_download;
    const next = mergeAutoDownloadFormats(
      latest,
      selected.value.map((item) => item.value),
    );
    if (
      latest.length === next.length &&
      latest.every((format, index) => format === next[index])
    ) {
      return;
    }

    const nextMetadata = notebook.value.buildMetadataUpdate({
      appConfig: { ...latestMetadata.appConfig, auto_download: next },
    });
    const edit = new code.WorkspaceEdit();
    edit.set(notebook.value.uri, [
      code.NotebookEdit.updateNotebookMetadata(nextMetadata),
    ]);
    const applied = yield* code.workspace.applyEdit(edit);
    if (!applied) {
      yield* code.window.showErrorMessage("Could not update export formats.");
      return;
    }

    const saved = yield* notebook.value
      .save()
      .pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError("Failed to save automatic export settings").pipe(
            Effect.annotateLogs({ cause, notebook: notebook.value.id }),
            Effect.as(false),
          ),
        ),
      );
    if (!saved) {
      yield* code.window.showErrorMessage(
        "Export formats changed but the notebook could not be saved.",
      );
      return;
    }

    const label = next
      .filter(isManagedFormat)
      .map((format) => format.toUpperCase())
      .join(", ");
    yield* code.window.showInformationMessage(
      label.length > 0
        ? `Automatic exports enabled for ${label}.`
        : "Automatic exports disabled.",
    );
  },
);
