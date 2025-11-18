import type { CellOutput } from "@marimo-team/frontend/unstable_internal/core/kernel/messages.ts";
import { unreachable } from "../assert.ts";

export type ExtendsArray<T> = T extends Array<infer U> ? U : never;

export type MarimoError = ExtendsArray<CellOutput["data"]>;

export type CellIdMapper = (cellId: string) => string | undefined;

export function prettyErrorMessage(
  error: MarimoError,
  cellIdMapper?: CellIdMapper,
): string {
  switch (error.type) {
    case "setup-refs":
      return formatSetupRootError(error);
    case "cycle":
      return formatCycleError(error);
    case "multiple-defs":
      return formatMultipleDefinitionError(error, cellIdMapper);
    case "import-star":
      return error.msg;
    case "ancestor-stopped":
      return `Execution stopped because cell ${error.raising_cell} was stopped. ${error.msg}`;
    case "ancestor-prevented":
      return `Execution prevented: ${error.msg}${error.blamed_cell ? ` (cell: ${error.blamed_cell})` : ""}`;
    case "exception":
      return `${error.exception_type}: ${error.msg}${error.raising_cell ? ` (raised in cell: ${error.raising_cell})` : ""}`;
    case "strict-exception":
      return `Strict execution error: ${error.msg} (ref: ${error.ref}${error.blamed_cell ? `, cell: ${error.blamed_cell}` : ""})`;
    case "interruption":
      return "Execution interrupted";
    case "syntax":
      return `Syntax error: ${error.msg}`;
    case "internal":
      return `Internal error (ID: ${error.error_id})${error.msg ? `: ${error.msg}` : ""}`;
    case "sql-error":
      return formatSQLError(error);
    case "unknown":
      return `${error.error_type ? `${error.error_type}: ` : ""}${error.msg}`;
    default: {
      unreachable(error);
    }
  }
}

function formatSetupRootError(
  error: Extract<MarimoError, { type: "setup-refs" }>,
): string {
  const edges = error.edges_with_vars
    .map(([from, vars, to]) => `  ${from} → [${vars.join(", ")}] → ${to}`)
    .join("\n");
  return `Setup references error:\n${edges}`;
}

function formatCycleError(
  error: Extract<MarimoError, { type: "cycle" }>,
): string {
  const edges = error.edges_with_vars
    .map(([from, vars, to]) => `  ${from} → [${vars.join(", ")}] → ${to}`)
    .join("\n");
  return `Cycle detected in notebook:\n${edges}`;
}

function formatMultipleDefinitionError(
  error: Extract<MarimoError, { type: "multiple-defs" }>,
  cellIdMapper?: CellIdMapper,
): string {
  const cellNames = error.cells.map((cellId) => {
    const mapped = cellIdMapper?.(cellId);
    return mapped ?? cellId;
  });

  if (cellNames.length === 0) {
    return `Variable "${error.name}" is defined in multiple cells`;
  }

  // Check if we have HTML links (cellIdMapper was provided and worked)
  const hasHtmlLinks = cellNames.some((name) => name.includes("<a href="));

  if (hasHtmlLinks) {
    // Format as HTML with styling matching marimo's frontend
    const cellList = cellNames
      .map((name) => `<li style="margin: 4px 0;">${name}</li>`)
      .join("");
    return `
      <div style="font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); color: var(--vscode-foreground); line-height: 1.6;">
        <p style="margin: 0 0 12px 0; color: var(--vscode-errorForeground); font-weight: 600;">
          This cell wasn't run because it has errors
        </p>
        <p style="margin: 0 0 12px 0; color: var(--vscode-descriptionForeground); font-weight: 500;">
          This cell redefines variables from other cells.
        </p>
        <p style="margin: 0 0 4px 0; color: var(--vscode-descriptionForeground);">
          <code style="background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 3px; font-family: var(--vscode-editor-font-family);">${error.name}</code> was also defined by:
        </p>
        <ul style="margin: 8px 0 16px 0; padding-left: 20px; list-style-type: disc;">
          ${cellList}
        </ul>
        <details style="margin-top: 16px; cursor: pointer;">
          <summary style="color: var(--vscode-descriptionForeground); font-weight: 500; margin-bottom: 8px;">Why can't I redefine variables?</summary>
          <div style="padding-left: 8px; margin-top: 8px; border-left: 2px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground);">
            <p style="margin: 0 0 12px 0;">
              marimo requires that each variable is defined in just one cell. This constraint enables reactive and reproducible execution, arbitrary cell reordering, seamless UI elements, execution as a script, and more.
            </p>
            <p style="margin: 0 0 12px 0;">
              Try merging this cell with the mentioned cells or wrapping it in a function. Alternatively, rename variables to make them private to this cell by prefixing them with an underscore (e.g. <code style="background: var(--vscode-textCodeBlock-background); padding: 2px 4px; border-radius: 3px;">_${error.name}</code>).
            </p>
            <p style="margin: 0;">
              <a href="https://docs.marimo.io/guides/reactivity.html#multiple-definition-error" style="color: var(--vscode-textLink-foreground);">Learn more at our docs ↗</a>
            </p>
          </div>
        </details>
      </div>
    `.trim();
  }

  // Fall back to plain text format
  if (cellNames.length === 1) {
    return `This cell redefines variables from other cells.\n\n'${error.name}' was also defined by:\n  • ${cellNames[0]}`;
  }

  const cellList = cellNames.map((name) => `  • ${name}`).join("\n");
  return `This cell redefines variables from other cells.\n\n'${error.name}' was also defined by:\n${cellList}`;
}

function formatSQLError(
  error: Extract<MarimoError, { type: "sql-error" }>,
): string {
  const location =
    error.sql_line !== null && error.sql_col !== null
      ? ` at line ${error.sql_line}, column ${error.sql_col}`
      : "";
  const hint = error.hint ? `\nHint: ${error.hint}` : "";
  return `SQL Error${location}: ${error.msg}\nStatement: ${error.sql_statement}${hint}`;
}
