const { defineConfig } = require("@vscode/test-cli");

module.exports = defineConfig([
  {
    label: "extension",
    files: "tests/*.test.cjs",
    version: "insiders",
    workspaceFolder: "./tests/sampleWorkspace",
    installExtensions: ["ms-python.python"],
    mocha: {
      ui: "tdd",
      timeout: 60000,
    },
  },
]);
