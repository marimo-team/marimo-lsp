// @ts-check
/// <reference types="mocha" />

const NodeAssert = require("node:assert");
const vscode = require("vscode");

const { createTestContext } = require("./helpers.cjs");

suite("metadata dirty tracking", () => {
  test("deserialized runtime metadata stays clean while persisted metadata dirties", async function () {
    await using ctx = createTestContext();
    const notebook = await ctx.writeAndOpenNotebook();
    const original = notebook.cellAt(0).metadata;

    NodeAssert.strictEqual(notebook.isDirty, false);
    NodeAssert.strictEqual(
      typeof original.marimoRuntime.stableId,
      "string",
      "deserialization should establish runtime identity without an edit",
    );

    const persistedEdit = new vscode.WorkspaceEdit();
    persistedEdit.set(notebook.uri, [
      vscode.NotebookEdit.updateCellMetadata(0, {
        ...original,
        marimo: {
          ...original.marimo,
          name: "renamed_cell",
        },
      }),
    ]);
    NodeAssert.strictEqual(
      await vscode.workspace.applyEdit(persistedEdit),
      true,
    );
    NodeAssert.strictEqual(
      notebook.isDirty,
      true,
      "changing persisted marimo metadata must dirty the notebook",
    );
  });

  test("persisted notebook metadata dirties the document", async function () {
    await using ctx = createTestContext();
    const notebook = await ctx.writeAndOpenNotebook();
    const original = notebook.metadata;

    NodeAssert.strictEqual(notebook.isDirty, false);

    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [
      vscode.NotebookEdit.updateNotebookMetadata({
        ...original,
        marimo: {
          ...original.marimo,
          header: "# updated header",
        },
      }),
    ]);
    NodeAssert.strictEqual(await vscode.workspace.applyEdit(edit), true);
    NodeAssert.strictEqual(
      notebook.isDirty,
      true,
      "changing persisted notebook metadata must dirty the notebook",
    );
  });
});
