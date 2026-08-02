import { Effect, Option } from "effect";

import type { NotebookCommandContext } from "../commands.ts";
import { MarimoConfigurationService } from "../config/MarimoConfigurationService.ts";
import { getNotebookCommandEditor } from "../lib/getNotebookCommandEditor.ts";
import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";
import { configureAutoExport } from "./configureAutoExport.ts";
import { toggleAutoReload } from "./toggleAutoReload.ts";
import { toggleOnCellChange } from "./toggleOnCellChange.ts";

export const showNotebookActions = Effect.fn("command.showNotebookActions")(
  function* (context?: NotebookCommandContext) {
    const code = yield* VsCode;
    const selection = yield* code.window.showQuickPickItems(
      [
        {
          label: "$(zap) Reactivity",
          detail: "Choose what happens when cells or imported modules change",
          value: "reactivity" as const,
        },
        {
          label: "$(save-all) Automatic exports",
          detail: "Save HTML or IPYNB copies when the notebook changes",
          value: "exports" as const,
        },
      ],
      { title: "marimo notebook" },
    );

    if (Option.isNone(selection)) return;
    if (selection.value.value === "exports") {
      yield* configureAutoExport(context);
      return;
    }

    const configService = yield* MarimoConfigurationService;
    const notebook = Option.filterMap(
      yield* getNotebookCommandEditor(context),
      (editor) => MarimoNotebookDocument.tryFrom(editor.notebook),
    );
    if (Option.isNone(notebook)) {
      yield* code.window.showWarningMessage(
        "Open a marimo notebook to configure reactivity.",
      );
      return;
    }

    const config = yield* configService.getConfig(notebook.value.id);
    const onCellChange = config.runtime?.on_cell_change ?? "autorun";
    const autoReload = config.runtime?.auto_reload ?? "off";
    const reactivity = yield* code.window.showQuickPickItems(
      [
        {
          label: "Cell changes",
          description: onCellChange === "autorun" ? "Automatic" : "Mark stale",
          detail: "Control when dependent cells run",
          value: "cells" as const,
        },
        {
          label: "Module changes",
          description:
            autoReload === "autorun"
              ? "Automatic"
              : autoReload === "lazy"
                ? "Mark stale"
                : "Off",
          detail: "Control what happens when imported modules change",
          value: "modules" as const,
        },
      ],
      { title: "Reactivity" },
    );

    if (Option.isNone(reactivity)) return;
    yield* reactivity.value.value === "cells"
      ? toggleOnCellChange(context)
      : toggleAutoReload(context);
  },
);
