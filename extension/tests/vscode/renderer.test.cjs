// @ts-check
/// <reference types="mocha" />

const NodeAssert = require("node:assert/strict");
const NodeFs = require("node:fs/promises");
const NodePath = require("node:path");
const { chromium, expect } = require("@playwright/test");
const {
  createTestContext,
  selectKernel,
  runCell,
  cellOutputText,
  editCell,
} = require("./helpers.cjs");

const SOURCE = `import marimo

app = marimo.App()

@app.cell
def _():
    import marimo as mo
    table = mo.ui.table([{"name": "Charlie", "age": 35, "city": "Paris"}])
    table
    return (table,)

@app.cell
def _(table):
    print(f"selected rows: {len(table.value)}")
    return

if __name__ == "__main__":
    app.run()
`;

suite("rendered notebook outputs", function () {
  this.timeout(60_000);

  test("renders and selects a table in the VS Code webview", async function () {
    const userDataDir = process.env.MARIMO_TEST_USER_DATA_DIR;
    NodeAssert.ok(
      userDataDir,
      "VS Code must launch with renderer inspection enabled",
    );
    const [port, endpoint] = (
      await NodeFs.readFile(
        NodePath.join(userDataDir, "DevToolsActivePort"),
        "utf8",
      )
    )
      .trim()
      .split(/\r?\n/);
    const browser = await chromium.connectOverCDP(
      `ws://127.0.0.1:${port}${endpoint}`,
    );
    try {
      /** @type {string[]} */
      const rendererErrors = [];
      for (const page of browser
        .contexts()
        .flatMap((context) => context.pages())) {
        page.on("pageerror", (error) => {
          if (error.stack?.includes("/renderer.mjs"))
            rendererErrors.push(error.stack);
        });
        page.on("console", (message) => {
          if (
            message.type() === "error" &&
            message.location().url.includes("/renderer.mjs")
          ) {
            rendererErrors.push(message.text());
          }
        });
      }
      await using ctx = createTestContext();
      const notebook = await ctx.writeAndOpenNotebook(SOURCE);
      await selectKernel(notebook);
      await runCell(notebook.cellAt(0));
      await runCell(notebook.cellAt(1));
      NodeAssert.match(cellOutputText(notebook.cellAt(1)), /selected rows: 0/);
      /** @type {import('@playwright/test').Frame | undefined} */
      let outputFrame;
      await expect
        .poll(
          async () => {
            const frames = browser
              .contexts()
              .flatMap((context) => context.pages())
              .flatMap((page) => page.frames());
            const visible = await Promise.all(
              frames.map((frame) =>
                frame
                  .locator("marimo-table")
                  .getByRole("cell", { name: "Charlie", exact: true })
                  .isVisible(),
              ),
            );
            outputFrame = frames.find((_, index) => visible[index]);
            return outputFrame !== undefined;
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      NodeAssert.ok(outputFrame);
      const table = outputFrame.locator("marimo-table");
      await expect(
        table.getByRole("cell", { name: "Charlie", exact: true }),
      ).toBeVisible();
      await table
        .getByRole("checkbox", { name: "Select row", exact: true })
        .click();
      await expect(
        table.getByRole("checkbox", { name: "Select row", exact: true }),
      ).toBeChecked();
      await expect
        .poll(() => cellOutputText(notebook.cellAt(1)), { timeout: 15_000 })
        .toMatch(/selected rows: 1/);

      const cell = notebook.cellAt(0);
      await editCell(cell, cell.document.getText().replace("Charlie", "Alice"));
      await runCell(cell);
      await expect(
        table.getByRole("cell", { name: "Alice", exact: true }),
      ).toBeVisible();
      await expect(
        table.getByRole("cell", { name: "Charlie", exact: true }),
      ).toHaveCount(0);
      await expect
        .poll(() => cellOutputText(notebook.cellAt(1)), { timeout: 15_000 })
        .toMatch(/selected rows: 0/);
      NodeAssert.deepEqual(
        rendererErrors,
        [],
        "renderer should not log errors",
      );
    } finally {
      await browser.close();
    }
  });
});
