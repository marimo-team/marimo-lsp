"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LanguageId = exports.SETUP_CELL_NAME = exports.NOTEBOOK_TYPE = void 0;
exports.NOTEBOOK_TYPE = "marimo-notebook";
exports.SETUP_CELL_NAME = "setup";
exports.LanguageId = {
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
};
