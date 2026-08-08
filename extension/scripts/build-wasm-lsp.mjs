// @ts-check
/** Build the offline Pyodide environment bundled with the extension. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";

import { loadPyodide } from "pyodide";

const extensionDir = NodePath.dirname(
  NodeUrl.fileURLToPath(new URL("../package.json", import.meta.url)),
);
const repositoryDir = NodePath.dirname(extensionDir);
const pyodideDir = NodePath.dirname(
  NodeUrl.fileURLToPath(import.meta.resolve("pyodide")),
);
const outputDir = NodePath.join(extensionDir, "bundled", "wasm");
const uvCacheDir = NodePath.join(NodeOs.tmpdir(), "marimo-lsp-uv-cache");
const pyodidePackage = JSON.parse(
  NodeFs.readFileSync(NodePath.join(pyodideDir, "package.json"), "utf8"),
);
const packageBaseUrl = `https://cdn.jsdelivr.net/pyodide/v${pyodidePackage.version}/full/`;
const runtimeFiles = [
  "pyodide.js",
  "pyodide.asm.mjs",
  "pyodide.asm.wasm",
  "pyodide-lock.json",
  "python_stdlib.zip",
];

// TODO: Remove click after refactoring this eager import chain upstream:
// marimo_lsp.sessions
// └── marimo._session.managers
//     └── marimo._session.managers.ipc
//         └── marimo._cli.sandbox
//             └── import click
const pyodidePackages = ["click", "micropip", "msgspec", "pyyaml"];

/** @type {string | undefined} */
let buildDir;
try {
  buildDir = NodeFs.mkdtempSync(
    NodePath.join(NodeOs.tmpdir(), "marimo-lsp-wasm-"),
  );
  NodeFs.rmSync(outputDir, { recursive: true, force: true });
  NodeFs.mkdirSync(outputDir, { recursive: true });
  for (const filename of runtimeFiles) {
    NodeFs.copyFileSync(
      NodePath.join(pyodideDir, filename),
      NodePath.join(outputDir, filename),
    );
  }

  NodeChildProcess.execFileSync(
    "uv",
    ["build", "--wheel", "--out-dir", buildDir],
    {
      cwd: repositoryDir,
      env: { ...process.env, UV_CACHE_DIR: uvCacheDir },
      stdio: "inherit",
    },
  );
  const wheel = NodeFs.readdirSync(buildDir).find(
    (filename) =>
      filename.startsWith("marimo_lsp-") && filename.endsWith(".whl"),
  );
  if (wheel === undefined) throw new Error("uv did not produce a wheel");

  const lock = JSON.parse(
    NodeFs.readFileSync(NodePath.join(pyodideDir, "pyodide-lock.json"), "utf8"),
  );
  const pyodide = await loadPyodide({
    indexURL: pyodideDir,
    lockFileContents: lock,
    packageBaseUrl,
    packageCacheDir: NodePath.join(buildDir, "package-cache"),
  });
  await pyodide.loadPackage(pyodidePackages);

  const micropip = pyodide.pyimport("micropip");
  try {
    // micropip opens file: URLs on the host filesystem as raw URL paths,
    // which breaks on Windows: file:///C:/... is read as /C:/... (resolved
    // against the current drive) and percent-escapes (e.g. %7E for the ~ in
    // 8.3 temp paths) are never decoded. Stage the wheel inside the
    // Emscripten FS instead.
    pyodide.FS.writeFile(
      `/${wheel}`,
      NodeFs.readFileSync(NodePath.join(buildDir, wheel)),
    );
    await micropip.install(`emfs:/${wheel}`);
  } finally {
    micropip.destroy();
  }

  pyodide.runPython(`
from pathlib import Path
import shutil
import sysconfig

site_packages = Path(sysconfig.get_path("purelib"))
excluded = ("micropip", "jedi", "parso", "pygments", "docutils")
for package in excluded:
    shutil.rmtree(site_packages / package, ignore_errors=True)
    for metadata in site_packages.glob(f"{package}-*.dist-info"):
        shutil.rmtree(metadata)

if list(site_packages.glob("marimo-*.dist-info")):
    raise RuntimeError("The bundle must not contain the full marimo distribution")
if not list(site_packages.glob("marimo_base-*.dist-info")):
    raise RuntimeError("The bundle must contain marimo-base")

shutil.make_archive("/marimo-lsp-site-packages", "zip", site_packages)
`);
  NodeFs.writeFileSync(
    NodePath.join(outputDir, "site-packages.zip"),
    pyodide.FS.readFile("/marimo-lsp-site-packages.zip"),
  );
  NodeFs.writeFileSync(
    NodePath.join(outputDir, "manifest.json"),
    `${JSON.stringify(
      { pyodide: pyodide.version, pyodideNpm: pyodidePackage.version },
      null,
      2,
    )}\n`,
  );
  console.log(`Built offline WASM language server in ${outputDir}`);
} finally {
  if (buildDir !== undefined) {
    NodeFs.rmSync(buildDir, { recursive: true, force: true });
  }
}
