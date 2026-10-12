const { defineConfig } = require("@vscode/test-cli");

module.exports = defineConfig([
  {
    label: "extension",
    files: "tests/vscode/*.test.cjs",
    version: "insiders",
    workspaceFolder: "./tests/fixtures/sampleWorkspace",
    // ty is no longer installed on demand, so the host needs the official
    // extension to provide the binary the diagnostics test exercises.
    installExtensions: ["ms-python.python", "astral-sh.ty"],
    mocha: {
      ui: "tdd",
      timeout: 30_000,
      require: ["./tests/vscode/setup.cjs"],
    },
  },
  {
    // A separate instance: these suites assert on the whole window's
    // notebook state, and notebooks the main suite opens through the API
    // stay pinned by the extension host for minutes after they close.
    label: "lifecycle",
    files: "tests/vscode/lifecycle/*.test.cjs",
    version: "insiders",
    workspaceFolder: "./tests/fixtures/sampleWorkspace",
    installExtensions: ["ms-python.python", "astral-sh.ty"],
    mocha: {
      ui: "tdd",
      timeout: 30_000,
    },
  },
]);
