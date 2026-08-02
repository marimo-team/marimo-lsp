import { Effect, Option } from "effect";

import type { AutoExportFormat } from "../features/AutoExport.ts";
import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";
import type { _AppConfig } from "../schemas/Models.gen.ts";

const FORMATS = ["html", "ipynb"] as const;

const isManagedFormat = (format: string): format is AutoExportFormat =>
  format === "html" || format === "ipynb";

export function mergeAutoDownloadFormats(
  current: _AppConfig["auto_download"],
  selected: ReadonlyArray<AutoExportFormat>,
): _AppConfig["auto_download"] {
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
  function* () {
    const code = yield* VsCode;
    const notebook = Option.filterMap(
      yield* code.window.getActiveNotebookEditor(),
      (editor) => MarimoNotebookDocument.tryFrom(editor.notebook),
    );

    if (Option.isNone(notebook)) {
      yield* code.window.showWarningMessage(
        "Must have an open marimo notebook to configure automatic exports.",
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
      ],
      {
        placeHolder: "Select formats to save under __marimo__",
        title: "Automatic exports",
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
      yield* code.window.showErrorMessage(
        "Could not update automatic export settings.",
      );
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
        "Automatic export settings could not be saved.",
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
        : "Automatic HTML and IPYNB exports disabled.",
    );
  },
);
