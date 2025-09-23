#!/usr/bin/env node

import { runTests } from "@vscode/test-electron";
import * as path from "path";

async function main(): Promise<void> {
  try {
    console.log("🚀 Starting marimo VSCode Extension Tests...");

    // The folder containing the Extension Manifest package.json
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");
    console.log("Extension path:", extensionDevelopmentPath);

    // The path to the test runner
    const extensionTestsPath = path.resolve(__dirname, "./suite/index.ts");
    console.log("Test suite path:", extensionTestsPath);

    // Download VS Code, unzip it and run the integration test
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        "--disable-extensions", // Disable other extensions during testing
        "--no-sandbox",
      ],
    });

    console.log("✅ All extension tests passed!");
  } catch (err) {
    console.error("❌ Failed to run extension tests:", err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
