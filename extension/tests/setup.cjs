// @ts-check
/// <reference types="mocha" />

// Root hook plugin. Runs once before any test. Activating the extension
// here triggers `ensureSharedVenv` internally — the venv + `uv pip install
// marimo` cost is borne once at startup instead of inside individual tests,
// so tests can keep tight default timeouts.
//
// See https://mochajs.org/#root-hook-plugins

const { activateExtension } = require("./helpers.cjs");

module.exports.mochaHooks = {
  // Cold install on a fresh CI container: `uv pip install marimo` can take
  // 20–40s. Give it plenty of room; subsequent test timeouts stay tight.
  beforeAll: async function () {
    this.timeout(120_000);
    await activateExtension();
  },
};
