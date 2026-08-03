import type { NotebookToolbarContext } from "../commands.ts";
import { createConfigToggle } from "../lib/createConfigToggle.ts";

export const toggleOnCellChange = (context?: NotebookToolbarContext) =>
  createConfigToggle({
    context,
    configPath: "runtime.on_cell_change",
    settingName: "Cell changes",
    pickerTitle: "Cell changes",
    getCurrentValue: (config) => config.runtime?.on_cell_change ?? "autorun",
    choices: [
      {
        label: "Auto-run",
        detail:
          "Run dependent cells immediately after an upstream cell changes",
        value: "autorun" as const,
      },
      {
        label: "Lazy",
        detail: "Mark dependent cells stale and run them only when needed",
        value: "lazy" as const,
      },
    ],
    getDisplayName: (value) => (value === "autorun" ? "Auto-run" : "Lazy"),
  });
