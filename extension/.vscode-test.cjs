const { defineConfig } = require("@vscode/test-cli");
const NodePath = require("node:path");

const userDataDir = NodePath.join(__dirname, ".vscode-test", "user-data");

module.exports = defineConfig([
  {
    label: "extension",
    files: "tests/vscode/*.test.cjs",
    version: "insiders",
    workspaceFolder: "./tests/fixtures/sampleWorkspace",
    // Let renderer tests inspect this VS Code instance's notebook webviews.
    // Chromium chooses a free port and writes it to DevToolsActivePort.
    launchArgs: ["--remote-debugging-port=0", `--user-data-dir=${userDataDir}`],
    env: { MARIMO_TEST_USER_DATA_DIR: userDataDir },
    // ty is no longer installed on demand, so the host needs the official
    // extension to provide the binary the diagnostics test exercises.
    installExtensions: ["ms-python.python", "astral-sh.ty"],
    mocha: {
      ui: "tdd",
      timeout: 30_000,
      require: ["./tests/vscode/setup.cjs"],
    },
  },
]);
