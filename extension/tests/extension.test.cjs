// @ts-check
/// <reference types="mocha" />

const NodeAssert = require("node:assert");
const NodeFs = require("node:fs/promises");
const NodeOs = require("node:os");
const NodePath = require("node:path");
const vscode = require("vscode");
const tinyspy = require("tinyspy");

function getExtension() {
  const ext = vscode.extensions.getExtension("marimo-team.vscode-marimo");
  NodeAssert.ok(ext, "Extension should be found");
  if (!ext) {
    throw new Error("Extension should be found");
  }
  return ext;
}

suite("marimo Extension Hello World Tests", () => {
  suiteTeardown(() => {
    vscode.window.showInformationMessage("All tests done!");
  });

  test("Extension should be present and activatable", async () => {
    const extension = getExtension();
    await extension.activate();
    NodeAssert.strictEqual(
      extension.isActive,
      true,
      "Extension should be active after activation",
    );
  });

  test("Commands match package.json", async () => {
    const extension = getExtension();
    const packageJSON = extension.packageJSON;
    const commands = await vscode.commands.getCommands();
    const marimoCommands = commands.filter((cmd) => cmd.startsWith("marimo."));
    for (const { command } of packageJSON.contributes.commands) {
      NodeAssert.ok(marimoCommands.includes(command));
    }
  });

  test("Should contribute view containers", async () => {
    const packageJSON = getExtension().packageJSON;
    NodeAssert.ok(
      packageJSON.contributes.viewsContainers,
      "Should have viewsContainers section",
    );
    NodeAssert.ok(
      packageJSON.contributes.viewsContainers.panel,
      "Should have panel view containers",
    );
    NodeAssert.strictEqual(
      packageJSON.contributes.viewsContainers.panel.length,
      1,
      "Should contribute one panel view container",
    );
    NodeAssert.strictEqual(
      packageJSON.contributes.viewsContainers.panel[0].id,
      "marimo-explorer",
      "Should contribute marimo-explorer view container",
    );
  });

  test("Should contribute views", async () => {
    const packageJSON = getExtension().packageJSON;
    NodeAssert.ok(packageJSON.contributes.views, "Should have views section");
    NodeAssert.ok(
      packageJSON.contributes.views["marimo-explorer"],
      "Should have views in marimo-explorer container",
    );
    const marimoViews = packageJSON.contributes.views["marimo-explorer"];
    NodeAssert.ok(marimoViews.length >= 3, "Should contribute views");
  });

  test("Should have proper extension metadata", async () => {
    const extension = getExtension();
    const packageJSON = extension.packageJSON;
    NodeAssert.strictEqual(packageJSON.name, "vscode-marimo");
    NodeAssert.strictEqual(packageJSON.displayName, "marimo");
    NodeAssert.strictEqual(
      packageJSON.description,
      "A marimo notebook extension for VS Code.",
    );
    NodeAssert.strictEqual(packageJSON.publisher, "marimo-team");
  });

  test("Should contribute notebook types", async () => {
    const packageJSON = getExtension().packageJSON;
    NodeAssert.ok(packageJSON.contributes, "Should have contributes section");
    NodeAssert.ok(
      packageJSON.contributes.notebooks,
      "Should contribute notebooks",
    );
    NodeAssert.strictEqual(
      packageJSON.contributes.notebooks.length,
      1,
      "Should contribute one notebook type",
    );
    NodeAssert.strictEqual(
      packageJSON.contributes.notebooks[0].type,
      "marimo-notebook",
      "Should contribute marimo-notebook type",
    );
  });

  test("Should register notebook renderer", async () => {
    const packageJSON = getExtension().packageJSON;
    NodeAssert.ok(
      packageJSON.contributes.notebookRenderer,
      "Should contribute notebook renderer",
    );
    NodeAssert.strictEqual(
      packageJSON.contributes.notebookRenderer.length,
      1,
      "Should contribute one renderer",
    );
    NodeAssert.strictEqual(
      packageJSON.contributes.notebookRenderer[0].id,
      "marimo-renderer",
      "Should have marimo-renderer id",
    );
  });

  test("marimo.newMarimoNotebook command creates Python document", async () => {
    const extension = getExtension();
    NodeAssert.ok(extension.isActive);

    const initialDocCount = vscode.workspace.textDocuments.length;
    const dir = await NodeFs.mkdtemp(
      NodePath.join(NodeOs.tmpdir(), "marimo-newtest-"),
    );
    const fakeUri = vscode.Uri.file(NodePath.join(dir, "Notebook.py"));

    const spy = tinyspy.spyOn(
      vscode.window,
      "showSaveDialog",
      async () => fakeUri,
    );

    try {
      await vscode.commands.executeCommand("marimo.newMarimoNotebook");

      const finalDocCount = vscode.workspace.textDocuments.length;
      NodeAssert.strictEqual(
        finalDocCount,
        initialDocCount + 1,
        "Should have created one new document",
      );
      const doc =
        vscode.workspace.textDocuments[
          vscode.workspace.textDocuments.length - 1
        ];
      NodeAssert.equal(
        fakeUri.fsPath,
        doc.uri.fsPath,
        "New document should be at the save dialog path",
      );
      NodeAssert.ok(
        doc.uri.path.endsWith(".py"),
        "New document should be a Python file",
      );
    } finally {
      spy.restore();
      await NodeFs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

suite("marimo Extension Experimental Kernels API", () => {
  /**
   * @returns {Promise<import("../src/platform/Api.ts").MarimoApi>}
   */
  async function getApi() {
    const extension = getExtension();
    if (!extension.isActive) {
      await extension.activate();
    }
    return extension.exports;
  }

  test("API should have experimental.kernels namespace", async () => {
    const api = await getApi();
    NodeAssert.ok(api, "API should be returned from extension");
    NodeAssert.ok(api.experimental, "API should have experimental namespace");
    NodeAssert.ok(
      api.experimental.kernels,
      "API should have experimental.kernels namespace",
    );
    NodeAssert.ok(
      typeof api.experimental.kernels.getKernel === "function",
      "experimental.kernels.getKernel should be a function",
    );
  });

  test("getKernel should return undefined for non-existent notebook", async () => {
    const api = await getApi();
    const fakeUri = vscode.Uri.parse("file:///non-existent-notebook.py");
    const kernel = await api.experimental.kernels.getKernel(fakeUri);
    NodeAssert.strictEqual(
      kernel,
      undefined,
      "getKernel should return undefined for non-existent notebook",
    );
  });
});
