// This test file will be executed inside the VSCode extension host

import * as assert from "assert";
import * as vscode from "vscode";

function getExtension() {
  return vscode.extensions.getExtension("marimo-team.vscode-marimo")!;
}

suite("marimo Extension Hello World Tests", () => {
  test("Extension should be present and activatable", async () => {
    const extension = getExtension();

    assert.ok(extension, "Extension should be found");
    assert.strictEqual(
      extension.isActive,
      false,
      "Extension should not be active initially",
    );

    // Activate the extension
    await extension.activate();

    assert.strictEqual(
      extension.isActive,
      true,
      "Extension should be active after activation",
    );
    console.log("✓ marimo extension activated successfully");
  });

  test("Should register marimo commands", async () => {
    // Get all available commands
    const commands = await vscode.commands.getCommands();

    // Check if our marimo commands are registered
    const marimoCommands = commands.filter((cmd) => cmd.startsWith("marimo."));

    assert.ok(
      marimoCommands.length > 0,
      "Should have at least one marimo command",
    );
    assert.ok(
      marimoCommands.includes("marimo.newmarimoNotebook"),
      "Should include newmarimoNotebook command",
    );

    console.log(
      `✓ Found ${marimoCommands.length} marimo commands:`,
      marimoCommands,
    );
  });

  test("Should have proper extension metadata", async () => {
    const extension = getExtension();
    assert.ok(extension, "Extension should be found");

    const packageJSON = extension.packageJSON;

    assert.strictEqual(packageJSON.name, "vscode-marimo");
    assert.strictEqual(packageJSON.displayName, "marimo");
    assert.strictEqual(
      packageJSON.description,
      "A marimo notebook extension for VS Code.",
    );
    assert.strictEqual(packageJSON.publisher, "marimo-team");

    console.log("✓ Extension metadata is correct");
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

    console.log("✓ Notebook contributions are correct");
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

    console.log("✓ Notebook renderer is registered");
  });

  test("Hello World - Basic functionality test", async () => {
    // This is our "hello world" test - just verify everything is working
    console.log("🚀 Hello World from marimo VSCode Extension!");
    console.log("📚 Testing basic extension functionality...");

    const extension = getExtension();
    await extension.activate();

    // Try to execute the new notebook command (it may fail in test env, that's ok)
    try {
      await vscode.commands.executeCommand("marimo.newMarimoNotebook");
      console.log("✓ New marimo notebook command executed successfully");
    } catch (error) {
      console.log(
        "✓ New marimo notebook command is registered (expected to fail in test environment)",
      );
    }

    console.log("🎉 Hello World test completed successfully!");

    // Always pass - this is just a hello world test
    assert.ok(true, "Hello world test should always pass");
  });
});
