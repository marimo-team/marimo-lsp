import { Effect, Option } from "effect";

import { defineCommand } from "../commands.ts";
import { MarimoConfigurationService } from "../config/MarimoConfigurationService.ts";
import { VsCode } from "../platform/VsCode.ts";
import { configureAutoExport } from "./configureAutoExport.ts";
import createSetupCell from "./createSetupCell.ts";
import type { NotebookTarget } from "./Invocation.ts";
import { MarimoCommands } from "./MarimoCommands.ts";
import publishMarimoNotebook from "./publishMarimoNotebook.ts";
import { toggleAutoReload } from "./toggleAutoReload.ts";
import { toggleOnCellChange } from "./toggleOnCellChange.ts";

export const NOTEBOOK_MENU_ITEMS = [
  {
    label: "$(zap) Reactivity",
    detail: "Choose when dependent code runs",
    value: "reactivity" as const,
  },
  {
    label: "$(save-all) Automatic exports",
    detail: "Keep HTML or IPYNB copies up to date",
    value: "automatic-exports" as const,
  },
  {
    label: "$(gear) Create setup cell",
    detail: "Add an initialization cell at the top of the notebook",
    value: "create-setup-cell" as const,
  },
  {
    label: "$(cloud-upload) Publish notebook",
    detail: "Share this notebook as a GitHub Gist",
    value: "publish-notebook" as const,
  },
] as const;

const handler = Effect.fn("command.showNotebookMenu")(function* (
  target: Option.Option<NotebookTarget>,
) {
  const code = yield* VsCode;
  const notebook = Option.map(target, (value) => value.document);
  const selection = yield* code.window.showQuickPickItems(NOTEBOOK_MENU_ITEMS, {
    placeHolder: "Choose a notebook action",
    title: "marimo notebook",
  });

  if (Option.isNone(selection)) return;

  switch (selection.value.value) {
    case "automatic-exports":
      yield* configureAutoExport(notebook);
      return;
    case "create-setup-cell":
      yield* createSetupCell.invoke(target);
      return;
    case "publish-notebook":
      yield* publishMarimoNotebook.invoke(target);
      return;
    case "reactivity":
      break;
  }

  const configService = yield* MarimoConfigurationService;
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
        description: onCellChange === "autorun" ? "Auto-run" : "Lazy",
        detail:
          onCellChange === "autorun"
            ? "Run dependent cells after an upstream cell changes"
            : "Mark dependent cells stale and run them only when needed",
        value: "cells" as const,
      },
      {
        label: "Module changes",
        description:
          autoReload === "autorun"
            ? "Auto-run"
            : autoReload === "lazy"
              ? "Lazy"
              : "Off",
        detail:
          autoReload === "autorun"
            ? "Reload edited modules and run affected cells automatically"
            : autoReload === "lazy"
              ? "Mark affected cells stale and run them only when needed"
              : "Ignore edits to imported Python modules",
        value: "modules" as const,
      },
    ],
    { title: "Reactivity" },
  );

  if (Option.isNone(reactivity)) return;
  yield* reactivity.value.value === "cells"
    ? toggleOnCellChange(notebook)
    : toggleAutoReload(notebook);
});

export default defineCommand(MarimoCommands.showNotebookMenu, handler);
