import type { NotebookCommandContext } from "../commands.ts";
import { createConfigToggle } from "../lib/createConfigToggle.ts";

export const toggleAutoReload = (context?: NotebookCommandContext) =>
  createConfigToggle({
    context,
    configPath: "runtime.auto_reload",
    settingName: "Module changes",
    pickerTitle: "Module changes",
    getCurrentValue: (config) => config.runtime?.auto_reload ?? "off",
    choices: [
      {
        label: "Ignore module changes",
        detail: "Keep the notebook unchanged when imported modules are edited",
        value: "off" as const,
      },
      {
        label: "Mark affected cells stale",
        detail: "Wait to run affected cells until they are needed",
        value: "lazy" as const,
      },
      {
        label: "Reload and run affected cells",
        detail: "Keep affected cells up to date automatically",
        value: "autorun" as const,
      },
    ],
    getDisplayName: (value) => {
      switch (value) {
        case "off":
          return "Off";
        case "lazy":
          return "Mark stale";
        case "autorun":
          return "Automatic";
        default:
          return value;
      }
    },
  });
