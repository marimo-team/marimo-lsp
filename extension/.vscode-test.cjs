const { defineConfig } = require("@vscode/test-cli");

module.exports = defineConfig([
  {
    label: "extension",
    files: "tests/*.test.cjs",
    version: "insiders",
    workspaceFolder: "./sampleWorkspace",
    mocha: {
      ui: "tdd",
      timeout: 20000,
    },
  },
]);
