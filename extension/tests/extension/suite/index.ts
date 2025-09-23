import { glob } from "glob";
import Mocha from "mocha";
import * as path from "path";

export function run(): Promise<void> {
  // Create the mocha test
  const mocha = new Mocha({
    ui: "tdd", // Use TDD interface for suite/test structure
    color: true,
    timeout: 10000, // 10 second timeout for extension tests
  });

  const testsRoot = path.resolve(import.meta.dirname, "..");

  return new Promise((resolve, reject) => {
    const globPattern = "**/**.test.ts";
    console.log(`Looking for test files in: ${testsRoot}`);
    console.log(`Using pattern: ${globPattern}`);

    glob(globPattern, { cwd: testsRoot })
      .then((files) => {
        console.log(`Found ${files.length} test files:`, files);

        // Add files to the test suite
        files.forEach((f) => {
          const fullPath = path.resolve(testsRoot, f);
          console.log(`Adding test file: ${fullPath}`);
          mocha.addFile(fullPath);
        });

        try {
          // Run the mocha test
          mocha.run((failures) => {
            if (failures > 0) {
              reject(new Error(`${failures} tests failed.`));
            } else {
              resolve();
            }
          });
        } catch (err) {
          console.error("Error running tests:", err);
          reject(err);
        }
      })
      .catch((err) => {
        console.error("Error finding test files:", err);
        reject(err);
      });
  });
}

