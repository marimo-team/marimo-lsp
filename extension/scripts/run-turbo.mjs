// @ts-check
/**
 * Run Turbo with hashes for build inputs that live outside extension/.
 *
 * extension/ is the pnpm/Turbo root, while the Python package and the linked
 * marimo frontend checkout are its siblings. Turbo intentionally cannot glob
 * outside its root, so pass deterministic digests as task env inputs.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";

const extensionDir = NodePath.dirname(
  NodeUrl.fileURLToPath(new URL("../package.json", import.meta.url)),
);
const repositoryDir = NodePath.dirname(extensionDir);
const marimoDir = NodePath.resolve(extensionDir, "..", "..", "marimo");

/** @param {NodeCrypto.Hash} hash @param {string} root @param {string} path */
function hashFile(hash, root, path) {
  hash.update(NodePath.relative(root, path));
  hash.update("\0");
  hash.update(NodeFs.readFileSync(path));
  hash.update("\0");
}

/** @param {string} repository @param {string[]} args */
async function gitOutput(repository, args) {
  const child = NodeChildProcess.spawn("git", args, {
    cwd: repository,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const chunks = [];
  for await (const chunk of child.stdout) chunks.push(chunk);
  const code = await completed;
  if (code !== 0) throw new Error(`git ${args[0]} exited with code ${code}`);
  return Buffer.concat(chunks);
}

/** @param {string} repository @param {string[]} paths */
async function gitSourceHash(repository, paths) {
  const hash = NodeCrypto.createHash("sha256");
  const outputs = await Promise.all(
    [
      ["rev-parse", ...paths.map((path) => `HEAD:${path}`)],
      ["diff", "--no-ext-diff", "--binary", "HEAD", "--", ...paths],
    ].map((args) => gitOutput(repository, args)),
  );
  for (const output of outputs) {
    hash.update(output);
    hash.update("\0");
  }

  const untracked = await gitOutput(repository, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...paths,
  ]);
  for (const relativePath of untracked
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort()) {
    hashFile(hash, repository, NodePath.join(repository, relativePath));
  }
  return hash.digest("hex");
}

/** @param {string} directory @param {(path: string) => boolean} matches */
function removeFiles(directory, matches) {
  if (!NodeFs.existsSync(directory)) return;
  for (const entry of NodeFs.readdirSync(directory, { withFileTypes: true })) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      removeFiles(path, matches);
    } else if (matches(path)) {
      NodeFs.rmSync(path);
    }
  }
}

const tasks = process.argv.slice(2);
if (tasks.length === 0) {
  throw new Error("Pass at least one Turbo task to run");
}
const wasmRequested = tasks.includes("build:wasm-lsp:bundle");
const rendererRequested = tasks.includes("build:renderer");
const frontendRequested = tasks.some((task) =>
  ["build:extension", "build:renderer"].includes(task),
);
const [frontendSourceHash, wasmSourceHash] = await Promise.all([
  frontendRequested
    ? gitSourceHash(marimoDir, [
        "frontend",
        "package.json",
        "packages",
        "patches",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
      ])
    : undefined,
  wasmRequested
    ? gitSourceHash(repositoryDir, [
        "pyproject.toml",
        "README.md",
        "src/marimo_lsp",
      ])
    : undefined,
]);

if (rendererRequested) {
  removeFiles(NodePath.join(extensionDir, "dist"), (path) =>
    /\.mjs(?:\.map)?$/.test(path),
  );
}
if (wasmRequested) {
  NodeFs.rmSync(NodePath.join(extensionDir, "bundled", "wasm"), {
    recursive: true,
    force: true,
  });
}

NodeChildProcess.execFileSync("pnpm", ["exec", "turbo", "run", ...tasks], {
  cwd: extensionDir,
  env: {
    ...process.env,
    BUILD_NODE_VERSION: process.version,
    // Keys build:wasm-lsp:bundle per OS: its output is platform-independent,
    // but a cross-platform remote-cache hit would skip running the build
    // script on the one platform (Windows) where its host quirks show up.
    MARIMO_LSP_BUILD_PLATFORM: process.platform,
    ...(frontendSourceHash === undefined
      ? {}
      : { MARIMO_FRONTEND_SOURCE_HASH: frontendSourceHash }),
    MARIMO_LSP_UV_VERSION: wasmRequested
      ? NodeChildProcess.execFileSync("uv", ["--version"], {
          encoding: "utf8",
        })
          .trim()
          .split(" ", 2)
          .join(" ")
      : "",
    ...(wasmSourceHash === undefined
      ? {}
      : { MARIMO_LSP_WASM_SOURCE_HASH: wasmSourceHash }),
  },
  // Windows cannot execute .cmd shims directly. Resolve pnpm through cmd.exe.
  shell: process.platform === "win32",
  stdio: "inherit",
});
