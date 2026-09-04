import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { InstanceRecord } from "../Api.gen.ts";
import { registerDiscoveryRecord } from "../LocalDiscoveryRegistry.ts";
import { windowsPrivatePath } from "../windowsPrivatePath.ts";

const temporaryDirectories: string[] = [];

const record = InstanceRecord.make({
  id: "00000000-0000-4000-8000-000000000001",
  kind: "vscode",
  name: "Code",
  pid: 123,
  started_at: "2026-09-03T12:00:00.000Z",
  url: "http://127.0.0.1:1234/api/marimo/v1",
  token: "secret",
});

async function temporaryDirectory(): Promise<string> {
  const path = await NodeFs.mkdtemp(
    NodePath.join(NodeOs.tmpdir(), "marimo-discovery-test-"),
  );
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => NodeFs.rm(path, { recursive: true, force: true })),
  );
});

describe("local discovery registry", { timeout: 30_000 }, () => {
  it("publishes a private record and removes only its own record", async () => {
    const root = await temporaryDirectory();
    const directory = NodePath.join(root, "marimo", "discovery", "v1");
    const recordPath = NodePath.join(directory, `${record.id}.json`);
    const registration = await registerDiscoveryRecord(record, directory);
    const other = InstanceRecord.make({
      ...record,
      id: "00000000-0000-4000-8000-000000000002",
    });
    await registerDiscoveryRecord(other, directory);

    expect(JSON.parse(await NodeFs.readFile(recordPath, "utf8"))).toEqual(
      record,
    );

    if (process.platform !== "win32") {
      expect({
        directory: (await NodeFs.stat(directory)).mode & 0o777,
        record: (await NodeFs.stat(recordPath)).mode & 0o777,
      }).toEqual({ directory: 0o700, record: 0o600 });
    }

    await registration.deregister();
    expect(await NodeFs.readdir(directory)).toEqual([`${other.id}.json`]);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a pre-existing discovery directory accessible to other users",
    async () => {
      const root = await temporaryDirectory();
      const directory = NodePath.join(root, "marimo", "discovery", "v1");
      await NodeFs.mkdir(directory, { recursive: true, mode: 0o755 });
      await NodeFs.chmod(NodePath.dirname(directory), 0o755);

      await expect(registerDiscoveryRecord(record, directory)).rejects.toThrow(
        "accessible to other users",
      );
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects broad Windows ACLs on existing directories and records",
    async () => {
      const root = await temporaryDirectory();
      const directory = NodePath.join(root, "marimo", "discovery", "v1");
      const registration = await registerDiscoveryRecord(record, directory);
      const recordPath = NodePath.join(directory, `${record.id}.json`);
      const icacls = NodePath.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "icacls.exe",
      );
      const run = NodeUtil.promisify(NodeChildProcess.execFile);

      // Numeric SIDs keep this independent of the Windows display language.
      await run(icacls, [recordPath, "/grant", "*S-1-1-0:R"]);
      await expect(windowsPrivatePath(recordPath)).rejects.toThrow(
        "accessible to other users",
      );
      await registration.deregister();
      await run(icacls, [directory, "/grant", "*S-1-1-0:(OI)(CI)R"]);
      await expect(registerDiscoveryRecord(record, directory)).rejects.toThrow(
        "accessible to other users",
      );
      expect(await NodeFs.readdir(directory)).toEqual([]);
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects a Windows junction without publishing into its target",
    async () => {
      const root = await temporaryDirectory();
      const directory = NodePath.join(root, "marimo", "discovery", "v1");
      const target = NodePath.join(root, "target");
      await NodeFs.mkdir(target);
      await windowsPrivatePath(NodePath.dirname(directory), true);
      await NodeFs.symlink(target, directory, "junction");

      await expect(registerDiscoveryRecord(record, directory)).rejects.toThrow(
        "link",
      );
      expect(await NodeFs.readdir(target)).toEqual([]);
    },
  );
});
