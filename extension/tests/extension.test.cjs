// @ts-check
/// <reference types="mocha" />

const assert = require("node:assert");
const vscode = require("vscode");

function getExtension() {
  const ext = vscode.extensions.getExtension("marimo-team.vscode-marimo");
  assert.ok(ext, "Extension should be found");
  return ext;
}

suite("marimo Extension Hello World Tests", () => {
  suiteTeardown(() => {
    vscode.window.showInformationMessage("All tests done!");
  });

  test("Extension should be present and activatable", async () => {
    const extension = getExtension();
    assert.strictEqual(
      extension.isActive,
      false,
      "Extension should not be active initially",
    );
    await extension.activate();
    assert.strictEqual(
      extension.isActive,
      true,
      "Extension should be active after activation",
    );
  });

  test("Should register marimo commands", async () => {
    const commands = await vscode.commands.getCommands();
    const marimoCommands = commands.filter((cmd) => cmd.startsWith("marimo."));
    marimoCommands.sort();
    assert.deepEqual(marimoCommands, [
      "marimo.convert",
      "marimo.dap",
      "marimo.deserialize",
      "marimo.interrupt",
      "marimo.newMarimoNotebook",
      "marimo.run",
      "marimo.serialize",
      "marimo.set_ui_element_value",
    ]);
  });

  test("Commands match package.json", async () => {
    const extension = getExtension();
    const packageJSON = extension.packageJSON;
    const commands = await vscode.commands.getCommands();
    const marimoCommands = commands.filter((cmd) => cmd.startsWith("marimo."));
    for (const { command } of packageJSON.contributes.commands) {
      assert.ok(marimoCommands.includes(command));
    }
  });

  test("Should have proper extension metadata", async () => {
    const extension = getExtension();
    const packageJSON = extension.packageJSON;
    assert.strictEqual(packageJSON.name, "vscode-marimo");
    assert.strictEqual(packageJSON.displayName, "marimo");
    assert.strictEqual(
      packageJSON.description,
      "A marimo notebook extension for VS Code.",
    );
    assert.strictEqual(packageJSON.publisher, "marimo-team");
  });

  test("Should contribute notebook types", async () => {
    const packageJSON = getExtension().packageJSON;
    assert.ok(packageJSON.contributes, "Should have contributes section");
    assert.ok(packageJSON.contributes.notebooks, "Should contribute notebooks");
    assert.strictEqual(
      packageJSON.contributes.notebooks.length,
      1,
      "Should contribute one notebook type",
    );
    assert.strictEqual(
      packageJSON.contributes.notebooks[0].type,
      "marimo-notebook",
      "Should contribute marimo-notebook type",
    );
  });

  test("Should register notebook renderer", async () => {
    const packageJSON = getExtension().packageJSON;
    assert.ok(
      packageJSON.contributes.notebookRenderer,
      "Should contribute notebook renderer",
    );
    assert.strictEqual(
      packageJSON.contributes.notebookRenderer.length,
      1,
      "Should contribute one renderer",
    );
    assert.strictEqual(
      packageJSON.contributes.notebookRenderer[0].id,
      "marimo-renderer",
      "Should have marimo-renderer id",
    );
  });

  test("marimo.newMarimoNotebook command creates untitled Python document", async () => {
    const extension = getExtension();
    assert.ok(extension.isActive);

    const initialDocCount = vscode.workspace.textDocuments.length;
    await vscode.commands.executeCommand("marimo.newMarimoNotebook");

    const finalDocCount = vscode.workspace.textDocuments.length;
    assert.strictEqual(
      finalDocCount,
      initialDocCount + 1,
      "Should have created one new document",
    );
    const doc =
      vscode.workspace.textDocuments[vscode.workspace.textDocuments.length - 1];
    assert.ok(
      doc.uri.path.includes("Untitled"),
      "New document should be untitled",
    );
    assert.ok(
      doc.uri.path.endsWith(".py"),
      "New document should be a Python file",
    );
  });
});
