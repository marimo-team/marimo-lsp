// AUTO-GENERATED FILE — DO NOT EDIT.
//
// Generated from `extension/package.json` and `pyproject.toml` by `scripts.codegen`.
// Regenerate with `just codegen`.
import type { CellId } from "./types.ts";

export type MarimoView =
  | "marimo-explorer-datasources"
  | "marimo-explorer-packages"
  | "marimo-explorer-recents"
  | "marimo-explorer-variables";

export const NOTEBOOK_TYPE = "marimo-notebook";

export const SETUP_CELL_NAME = "setup";

// oxlint-disable-next-line typescript/no-unsafe-type-assertion
export const SCRATCH_CELL_ID = "__scratch__" as CellId;

export const LanguageId = {
  /**
   * Language ID for Python cells in marimo notebooks.
   *
   * Using a custom language ID ("mo-python") prevents other
   * Python language servers from providing duplicate completions
   * and diagnostics.
   */
  Python: "mo-python",
  /** Language ID for SQL cells in marimo notebooks. */
  Sql: "sql",
  /** Language ID for Markdown cells in marimo notebooks. */
  Markdown: "markdown",
} as const;

export const MINIMUM_MARIMO_KERNEL_VERSION = {
  major: 0,
  minor: 23,
  patch: 3,
} as const;

export type MarimoContextKey =
  | "marimo.config.runtime.auto_reload"
  | "marimo.config.runtime.on_cell_change"
  | "marimo.isPythonFileMarimoNotebook"
  | "marimo.notebook.hasKernel"
  | "marimo.notebook.hasStaleCells";
