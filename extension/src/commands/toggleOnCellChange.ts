import { createConfigToggle } from "../utils/createConfigToggle.ts";

export const toggleOnCellChange = () =>
  createConfigToggle({
    configPath: "runtime.on_cell_change",
    getCurrentValue: (config) => config.runtime?.on_cell_change ?? "autorun",
    choices: [
      {
        label: "Auto-Run",
        detail: "Automatically run cells when their ancestors change",
        value: "autorun" as const,
      },
      {
        label: "Lazy",
        detail: "Mark cells stale when ancestors change, don't autorun",
        value: "lazy" as const,
      },
    ],
    getDisplayName: (value) => (value === "autorun" ? "Auto-Run" : "Lazy"),
  });
