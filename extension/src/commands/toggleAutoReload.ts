import type { NotebookToolbarContext } from "../commands.ts";
import { createConfigToggle } from "../lib/createConfigToggle.ts";

export const toggleAutoReload = (context?: NotebookToolbarContext) =>
  createConfigToggle({
    context,
    configPath: "runtime.auto_reload",
    settingName: "Module changes",
    pickerTitle: "Module changes",
    getCurrentValue: (config) => config.runtime?.auto_reload ?? "off",
    choices: [
      {
        label: "Off",
        detail: "Ignore edits to imported Python modules",
        value: "off" as const,
      },
      {
        label: "Lazy",
        detail: "Mark affected cells stale and run them only when needed",
        value: "lazy" as const,
      },
      {
        label: "Auto-run",
        detail: "Reload edited modules and run affected cells automatically",
        value: "autorun" as const,
      },
    ],
    getDisplayName: (value) => {
      switch (value) {
        case "off":
          return "Off";
        case "lazy":
          return "Lazy";
        case "autorun":
          return "Auto-run";
        default:
          return value;
      }
    },
  });
