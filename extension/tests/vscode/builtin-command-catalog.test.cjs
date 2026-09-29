const assert = require("node:assert/strict");

const vscode = require("vscode");
const catalog = require("../builtin-command-catalog.json");

suite("built-in command catalog", () => {
  test("every discoverable typed built-in command exists in VS Code", async () => {
    const available = new Set(await vscode.commands.getCommands(true));
    const discoverable = Object.entries(catalog)
      .filter(([, metadata]) => metadata.discoverable)
      .map(([command]) => command);

    assert.deepEqual(
      discoverable.filter((command) => !available.has(command)),
      [],
      "typed built-in command IDs must exist in the VS Code test host",
    );
  });
});
