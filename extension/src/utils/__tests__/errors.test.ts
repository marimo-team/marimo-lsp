import { describe, expect, it } from "vitest";
import { type MarimoError, prettyErrorMessage } from "../errors.ts";

describe("prettyErrorMessage", () => {
  it("handles setup-refs error", () => {
    const error: MarimoError = {
      type: "setup-refs",
      edges_with_vars: [
        ["cell_1", ["x", "y"], "cell_2"],
        ["cell_2", ["z"], "cell_3"],
      ],
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(`
			"Setup references error:
			  cell_1 → [x, y] → cell_2
			  cell_2 → [z] → cell_3"
		`);
  });

  it("handles cycle error", () => {
    const error: MarimoError = {
      type: "cycle",
      edges_with_vars: [
        ["cell_a", ["foo"], "cell_b"],
        ["cell_b", ["bar"], "cell_a"],
      ],
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(`
			"Cycle detected in notebook:
			  cell_a → [foo] → cell_b
			  cell_b → [bar] → cell_a"
		`);
  });

  it("handles multiple-defs error", () => {
    const error: MarimoError = {
      type: "multiple-defs",
      name: "my_variable",
      cells: ["cell_1", "cell_2", "cell_3"],
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(`
      "This cell redefines variables from other cells.

      'my_variable' was also defined by:
        • cell_1
        • cell_2
        • cell_3"
    `);
  });

  it("handles multiple-defs error with single cell", () => {
    const error: MarimoError = {
      type: "multiple-defs",
      name: "x",
      cells: ["cell_1"],
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(`
      "This cell redefines variables from other cells.

      'x' was also defined by:
        • cell_1"
    `);
  });

  it("handles multiple-defs error with cell ID mapper (plain text)", () => {
    const error: MarimoError = {
      type: "multiple-defs",
      name: "slider",
      cells: ["cell_id_abc", "cell_id_def"],
    };
    const cellIdMapper = (cellId: string) => {
      const map: Record<string, string> = {
        cell_id_abc: "cell-0",
        cell_id_def: "cell-2",
      };
      return map[cellId];
    };
    expect(prettyErrorMessage(error, cellIdMapper)).toMatchInlineSnapshot(`
      "This cell redefines variables from other cells.

      'slider' was also defined by:
        • cell-0
        • cell-2"
    `);
  });

  it("handles multiple-defs error with HTML cell links", () => {
    const error: MarimoError = {
      type: "multiple-defs",
      name: "slider",
      cells: ["cell_id_abc", "cell_id_def"],
    };
    const cellIdMapper = (cellId: string) => {
      const map: Record<string, string> = {
        cell_id_abc:
          '<a href="command:notebook.cell.focusInOutput?...">cell-0</a>',
        cell_id_def:
          '<a href="command:notebook.cell.focusInOutput?...">cell-2</a>',
      };
      return map[cellId];
    };
    const result = prettyErrorMessage(error, cellIdMapper);
    expect(result).toContain("<div");
    expect(result).toContain("<a href=");
    expect(result).toContain("cell-0</a>");
    expect(result).toContain("cell-2</a>");
    expect(result).toContain("<code");
    expect(result).toContain("slider</code>");
  });

  it("handles import-star error", () => {
    const error: MarimoError = {
      type: "import-star",
      msg: "Import star is not allowed in marimo notebooks",
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(
      `"Import star is not allowed in marimo notebooks"`,
    );
  });

  it("handles ancestor-stopped error", () => {
    const error: MarimoError = {
      type: "ancestor-stopped",
      msg: "Cell was not run because an ancestor was stopped",
      raising_cell: "cell_upstream",
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(
      `"Execution stopped because cell cell_upstream was stopped. Cell was not run because an ancestor was stopped"`,
    );
  });

  it("handles ancestor-prevented error with blamed cell", () => {
    const error: MarimoError = {
      type: "ancestor-prevented",
      msg: "Cell execution was prevented",
      raising_cell: "cell_parent",
      blamed_cell: "cell_child",
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(
      `"Execution prevented: Cell execution was prevented (cell: cell_child)"`,
    );
  });

  it("handles ancestor-prevented error without blamed cell", () => {
    const error: MarimoError = {
      type: "ancestor-prevented",
      msg: "Cell execution was prevented",
      raising_cell: "cell_parent",
      blamed_cell: null,
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(
      `"Execution prevented: Cell execution was prevented"`,
    );
  });

  it("handles exception error with raising cell", () => {
    const error: MarimoError = {
      type: "exception",
      msg: "division by zero",
      exception_type: "ZeroDivisionError",
      raising_cell: "cell_5",
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(
      `"ZeroDivisionError: division by zero (raised in cell: cell_5)"`,
    );
  });

  it("handles exception error without raising cell", () => {
    const error: MarimoError = {
      type: "exception",
      msg: "list index out of range",
      exception_type: "IndexError",
      raising_cell: null,
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(
      `"IndexError: list index out of range"`,
    );
  });

  it("handles strict-exception error with blamed cell", () => {
    const error: MarimoError = {
      type: "strict-exception",
      msg: "Variable accessed before definition",
      ref: "my_var",
      blamed_cell: "cell_10",
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(
      `"Strict execution error: Variable accessed before definition (ref: my_var, cell: cell_10)"`,
    );
  });

  it("handles strict-exception error without blamed cell", () => {
    const error: MarimoError = {
      type: "strict-exception",
      msg: "Variable accessed before definition",
      ref: "my_var",
      blamed_cell: null,
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(
      `"Strict execution error: Variable accessed before definition (ref: my_var)"`,
    );
  });

  it("handles interruption error", () => {
    const error: MarimoError = {
      type: "interruption",
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(
      `"Execution interrupted"`,
    );
  });

  it("handles syntax error", () => {
    const error: MarimoError = {
      type: "syntax",
      msg: "invalid syntax at line 5",
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(
      `"Syntax error: invalid syntax at line 5"`,
    );
  });

  it("handles internal error with message", () => {
    const error: MarimoError = {
      type: "internal",
      error_id: "abc123def456",
      msg: "Unexpected internal state",
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(
      `"Internal error (ID: abc123def456): Unexpected internal state"`,
    );
  });

  it("handles internal error without message", () => {
    const error: MarimoError = {
      type: "internal",
      error_id: "xyz789",
      msg: "",
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(
      `"Internal error (ID: xyz789)"`,
    );
  });

  it("handles sql-error with full location info", () => {
    const error: MarimoError = {
      type: "sql-error",
      msg: "column not found",
      sql_statement: "SELECT name, age FROM users WHERE id = 1",
      sql_line: 1,
      sql_col: 14,
      hint: "Did you mean 'user_name'?",
      node_lineno: 0,
      node_col_offset: 0,
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(`
			"SQL Error at line 1, column 14: column not found
			Statement: SELECT name, age FROM users WHERE id = 1
			Hint: Did you mean 'user_name'?"
		`);
  });

  it("handles sql-error without location info", () => {
    const error: MarimoError = {
      type: "sql-error",
      msg: "table does not exist",
      sql_statement: "SELECT * FROM nonexistent_table",
      sql_line: null,
      sql_col: null,
      hint: null,
      node_lineno: 0,
      node_col_offset: 0,
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(`
			"SQL Error: table does not exist
			Statement: SELECT * FROM nonexistent_table"
		`);
  });

  it("handles sql-error with hint but no location", () => {
    const error: MarimoError = {
      type: "sql-error",
      msg: "syntax error",
      sql_statement: "SELECT * FROM users",
      sql_line: null,
      sql_col: null,
      hint: "Check your SQL syntax",
      node_lineno: 0,
      node_col_offset: 0,
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(`
			"SQL Error: syntax error
			Statement: SELECT * FROM users
			Hint: Check your SQL syntax"
		`);
  });

  it("handles unknown error with error type", () => {
    const error: MarimoError = {
      type: "unknown",
      msg: "Something went wrong",
      error_type: "CustomError",
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(
      `"CustomError: Something went wrong"`,
    );
  });

  it("handles unknown error without error type", () => {
    const error: MarimoError = {
      type: "unknown",
      msg: "Something went wrong",
      error_type: null,
    };
    expect(prettyErrorMessage(error)).toMatchInlineSnapshot(
      `"Something went wrong"`,
    );
  });
});
