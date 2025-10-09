import type { CellOutput } from "@marimo-team/frontend/unstable_internal/core/kernel/messages.ts";
import { unreachable } from "../assert.ts";

export type ExtendsArray<T> = T extends Array<infer U> ? U : never;

export type MarimoError = ExtendsArray<CellOutput["data"]>;

export function prettyErrorMessage(error: MarimoError): string {
  switch (error.type) {
    case "setup-refs":
      return formatSetupRootError(error);
    case "cycle":
      return formatCycleError(error);
    case "multiple-defs":
      return formatMultipleDefinitionError(error);
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
): string {
  return `Variable "${error.name}" is defined in multiple cells: ${error.cells.join(", ")}`;
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
