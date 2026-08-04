const assert = require("node:assert/strict");

const vscode = require("vscode");

suite("built-in command catalog", () => {
  test("every discoverable typed built-in command exists in VS Code", async () => {
    const available = new Set(await vscode.commands.getCommands(true));
    const catalog = [
      "notebook.cell.collapseCellInput",
      "notebook.cell.execute",
      "notebook.cell.expandCellInput",
      "outline.focus",
      "workbench.action.openSettings",
      "workbench.action.reloadWindow",
    ];

    // `vscode.openWith` is executable but VS Code does not expose it through
    // getCommands(), so it cannot be checked through command enumeration.

    assert.deepEqual(
      catalog.filter((command) => !available.has(command)),
      [],
      "typed built-in command IDs must exist in the VS Code test host",
    );
  });
});
