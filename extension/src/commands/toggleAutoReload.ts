import { createConfigToggle } from "../utils/createConfigToggle.ts";

export const toggleAutoReload = () =>
  createConfigToggle({
    configPath: "runtime.auto_reload",
    getCurrentValue: (config) => config.runtime?.auto_reload ?? "off",
    choices: [
      {
        label: "Off",
        detail: "Don't reload modules automatically",
        value: "off" as const,
      },
      {
        label: "Lazy",
        detail: "Mark cells stale when modules change, don't autorun",
        value: "lazy" as const,
      },
      {
        label: "Auto-Run",
        detail: "Reload modules and automatically run affected cells",
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
          return "Auto-Run";
        default:
          return value;
      }
    },
  });
