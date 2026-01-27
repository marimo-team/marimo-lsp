// @ts-check
/**
 * Cross-platform script to build the Python sdist and extract it into dist/
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";
import * as tar from "tar";

const extensionDir = new URL("..", import.meta.url);
const distDir = NodePath.join(NodeUrl.fileURLToPath(extensionDir), "dist");

// Use UV_BINARY env var if set (e.g., for bundled uv in CI), otherwise fall back to "uv"
const uvBinary = process.env.UV_BINARY || "uv";

// Step 1: Run uv build
console.log(`Building Python sdist using: ${uvBinary}`);
NodeChildProcess.execFileSync(
  uvBinary,
  ["build", "--directory=..", "--out-dir=extension/dist", "--sdist"],
  {
    cwd: extensionDir,
    stdio: "inherit",
  },
);

// Step 2: Find the .tar.gz file
const files = NodeFs.readdirSync(distDir);
const tarball = files.find(
  (f) => f.startsWith("marimo_lsp-") && f.endsWith(".tar.gz"),
);

if (!tarball) {
  console.error("Could not find marimo_lsp-*.tar.gz in dist/");
  process.exit(1);
}

const tarballPath = NodePath.join(distDir, tarball);
console.log(`Extracting ${tarball}...`);

// Step 3: Extract the tarball using node-tar
await tar.extract({ file: tarballPath, cwd: distDir });

// Step 4: Remove the tarball
NodeFs.unlinkSync(tarballPath);
console.log("Done!");
