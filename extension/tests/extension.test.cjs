// @ts-check
/// <reference types="mocha" />

const assert = require("node:assert");
const vscode = require("vscode");
const tinyspy = require("tinyspy");

function getExtension() {
  const ext = vscode.extensions.getExtension("marimo-team.vscode-marimo");
  assert.ok(ext, "Extension should be found");
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

  test("Commands match package.json", async () => {
    const extension = getExtension();
    const packageJSON = extension.packageJSON;
    const commands = await vscode.commands.getCommands();
    const marimoCommands = commands.filter((cmd) => cmd.startsWith("marimo."));
    for (const { command } of packageJSON.contributes.commands) {
      assert.ok(marimoCommands.includes(command));
    }
  });

  test("Should contribute view containers", async () => {
    const packageJSON = getExtension().packageJSON;
    assert.ok(
      packageJSON.contributes.viewsContainers,
      "Should have viewsContainers section",
    );
    assert.ok(
      packageJSON.contributes.viewsContainers.panel,
      "Should have panel view containers",
    );
    assert.strictEqual(
      packageJSON.contributes.viewsContainers.panel.length,
      1,
      "Should contribute one panel view container",
    );
    assert.strictEqual(
      packageJSON.contributes.viewsContainers.panel[0].id,
      "marimo-explorer",
      "Should contribute marimo-explorer view container",
    );
  });

  test("Should contribute views", async () => {
    const packageJSON = getExtension().packageJSON;
    assert.ok(packageJSON.contributes.views, "Should have views section");
    assert.ok(
      packageJSON.contributes.views["marimo-explorer"],
      "Should have views in marimo-explorer container",
    );
    const marimoViews = packageJSON.contributes.views["marimo-explorer"];
    assert.ok(marimoViews.length >= 3, "Should contribute views");
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

  test("marimo.newMarimoNotebook command creates Python document", async () => {
    const extension = getExtension();
    assert.ok(extension.isActive);

    const initialDocCount = vscode.workspace.textDocuments.length;
    const fakeUri = vscode.Uri.parse("marimo-mock:///fake/path/Notebook.py");

    /**
     * VS Code's test environment is read-only,
     * so we cannot write to disk. Instead, we create
     * an in-memory filesystem to hold our single Python
     * file for this test.
     */
    {
      /** @type {Uint8Array | undefined} */
      let singleFileContent;
      const disposable = vscode.workspace.registerFileSystemProvider(
        "marimo-mock",
        {
          onDidChangeFile: new vscode.EventEmitter().event,
          /** @param {vscode.Uri} uri */
          readFile(uri) {
            if (uri.toString() !== fakeUri.toString()) {
              throw vscode.FileSystemError.FileNotFound(uri);
            }
            if (!singleFileContent) {
              throw vscode.FileSystemError.FileNotFound(uri);
            }
            return singleFileContent;
          },
          /**
           * @param {vscode.Uri} uri
           * @param {Uint8Array} content
           */
          writeFile(uri, content) {
            if (uri.toString() !== fakeUri.toString()) {
              throw vscode.FileSystemError.FileNotFound(uri);
            }
            singleFileContent = content;
          },
          watch() {
            return { dispose() {} };
          },
          /** @param {vscode.Uri} uri */
          stat(uri) {
            if (!singleFileContent) {
              throw vscode.FileSystemError.FileNotFound(uri);
            }
            return {
              type: vscode.FileType.File,
              ctime: 0,
              mtime: 0,
              size: singleFileContent.length,
            };
          },
          createDirectory() {},
          readDirectory() {
            throw vscode.FileSystemError.NoPermissions();
          },
          delete() {
            throw vscode.FileSystemError.NoPermissions();
          },
          rename() {
            throw vscode.FileSystemError.NoPermissions();
          },
          copy() {
            throw vscode.FileSystemError.NoPermissions();
          },
        },
        {
          isCaseSensitive: true,
        },
      );

      const spy = tinyspy.spyOn(
        vscode.window,
        "showSaveDialog",
        async () => fakeUri,
      );

      await vscode.commands.executeCommand("marimo.newMarimoNotebook");

      spy.restore();
      disposable.dispose();
    }

    const finalDocCount = vscode.workspace.textDocuments.length;
    assert.strictEqual(
      finalDocCount,
      initialDocCount + 1,
      "Should have created one new document",
    );
    const doc =
      vscode.workspace.textDocuments[vscode.workspace.textDocuments.length - 1];
    assert.equal(
      fakeUri.fsPath,
      doc.uri.fsPath,
      "New document should be untitled",
    );
    assert.ok(
      doc.uri.path.endsWith(".py"),
      "New document should be a Python file",
    );
  });
});

suite("marimo Extension Experimental Kernels API", () => {
  /**
   * @returns {Promise<import("../src/services/Api.ts").MarimoApi>}
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
    assert.ok(api, "API should be returned from extension");
    assert.ok(api.experimental, "API should have experimental namespace");
    assert.ok(
      api.experimental.kernels,
      "API should have experimental.kernels namespace",
    );
    assert.ok(
      typeof api.experimental.kernels.getKernel === "function",
      "experimental.kernels.getKernel should be a function",
    );
  });

  test("getKernel should return undefined for non-existent notebook", async () => {
    const api = await getApi();
    const fakeUri = vscode.Uri.parse("file:///non-existent-notebook.py");
    const kernel = await api.experimental.kernels.getKernel(fakeUri);
    assert.strictEqual(
      kernel,
      undefined,
      "getKernel should return undefined for non-existent notebook",
    );
  });
});
