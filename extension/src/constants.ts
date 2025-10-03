export const Commands = {
  "marimo.showMarimoMenu": "marimo.showMarimoMenu",
  "marimo.newMarimoNotebook": "marimo.newMarimoNotebook",
  "marimo.createGist": "marimo.createGist",
  "marimo.clearRecentNotebooks": "marimo.clearRecentNotebooks",
} as const;

export type MarimoCommandKey = (typeof Commands)[keyof typeof Commands];

export const Views = {
  "marimo-explorer-recents": "marimo-explorer-recents",
} as const;
export type MarimoViewKey = (typeof Views)[keyof typeof Views];

export const NOTEBOOK_TYPE = "marimo-notebook";
