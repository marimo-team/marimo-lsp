import type { NotebookCommandContext } from "../commands.ts";
import { createConfigToggle } from "../lib/createConfigToggle.ts";

export const toggleOnCellChange = (context?: NotebookCommandContext) =>
  createConfigToggle({
    context,
    configPath: "runtime.on_cell_change",
    settingName: "Cell changes",
    pickerTitle: "Cell changes",
    getCurrentValue: (config) => config.runtime?.on_cell_change ?? "autorun",
    choices: [
      {
        label: "Run dependent cells",
        detail: "Keep dependent cells up to date automatically",
        value: "autorun" as const,
      },
      {
        label: "Mark dependent cells stale",
        detail: "Wait to run dependent cells until they are needed",
        value: "lazy" as const,
      },
    ],
    getDisplayName: (value) =>
      value === "autorun" ? "Automatic" : "Mark stale",
  });
