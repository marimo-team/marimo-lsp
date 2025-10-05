export const Commands = {
  "marimo.showMarimoMenu": "marimo.showMarimoMenu",
  "marimo.newMarimoNotebook": "marimo.newMarimoNotebook",
  "marimo.createGist": "marimo.createGist",
  "marimo.runStale": "marimo.runStale",
  "marimo.clearRecentNotebooks": "marimo.clearRecentNotebooks",
} as const;

export type MarimoCommandKey = (typeof Commands)[keyof typeof Commands];

export const Views = {
  "marimo-explorer-recents": "marimo-explorer-recents",
  "marimo-explorer-variables": "marimo-explorer-variables",
} as const;
export type MarimoViewKey = (typeof Views)[keyof typeof Views];

export const ContextKeys = {
  "marimo.hasStaleCells": "marimo.hasStaleCells",
} as const;
export type MarimoContextKey = (typeof ContextKeys)[keyof typeof ContextKeys];

export const NOTEBOOK_TYPE = "marimo-notebook";
