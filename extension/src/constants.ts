export const Commands = {
  "marimo.showMarimoMenu": "marimo.showMarimoMenu",
  "marimo.newMarimoNotebook": "marimo.newMarimoNotebook",
  "marimo.createGist": "marimo.createGist",
} as const;

export type MarimoCommandKey = (typeof Commands)[keyof typeof Commands];

export const NOTEBOOK_TYPE = "marimo-notebook";
