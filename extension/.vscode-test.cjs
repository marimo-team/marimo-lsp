const { defineConfig } = require("@vscode/test-cli");

module.exports = defineConfig([
  {
    label: "extension",
    files: "tests/*.test.cjs",
    version: "insiders",
    workspaceFolder: "./tests/sampleWorkspace",
    // ty is no longer installed on demand, so the host needs the official
    // extension to provide the binary the diagnostics test exercises.
    installExtensions: ["ms-python.python", "astral-sh.ty"],
    mocha: {
      ui: "tdd",
      timeout: 30_000,
      require: ["./tests/setup.cjs"],
    },
  },
]);
