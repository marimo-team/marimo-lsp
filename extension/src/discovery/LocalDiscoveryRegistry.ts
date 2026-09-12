import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { Schema } from "effect";

import { InstanceRecord } from "./Api.gen.ts";
import { windowsPrivatePath } from "./windowsPrivatePath.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const encodeInstanceRecord = Schema.encodeSync(InstanceRecord);

function discoveryDirectory(): string {
  if (process.platform === "win32") {
    return NodePath.join(NodeOs.homedir(), ".marimo", "discovery", "v1");
  }
  const stateRoot = process.env.XDG_STATE_HOME?.trim();
  return NodePath.join(
    stateRoot ? stateRoot : NodePath.join(NodeOs.homedir(), ".local", "state"),
    "marimo",
    "discovery",
    "v1",
  );
}

async function verifyPrivateDirectory(path: string): Promise<void> {
  const info = await NodeFs.lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Discovery path is not a directory: ${path}`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`Discovery directory has a different owner: ${path}`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(
      `Discovery directory is accessible to other users: ${path}`,
    );
  }
}

async function verifyPrivateFile(path: string): Promise<void> {
  const info = await NodeFs.lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Discovery record is not a regular file: ${path}`);
  }
  if (process.platform === "win32") {
    await windowsPrivatePath(path);
    return;
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`Discovery record has a different owner: ${path}`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`Discovery record is accessible to other users: ${path}`);
  }
}

async function ensurePrivateDirectories(directory: string): Promise<void> {
  const discovery = NodePath.dirname(directory);
  const state = NodePath.dirname(discovery);
  await NodeFs.mkdir(state, { recursive: true });

  const ensure = async (path: string): Promise<void> => {
    if (process.platform === "win32") {
      await windowsPrivatePath(path, true);
      return;
    }
    try {
      await NodeFs.mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
    }
    await verifyPrivateDirectory(path);
  };
  await ensure(discovery);
  await ensure(directory);
}

/** Atomically publish one private instance record and return its cleanup. */
export async function registerDiscoveryRecord(
  record: typeof InstanceRecord.Type,
  directory = discoveryDirectory(),
) {
  await ensurePrivateDirectories(directory);
  const path = NodePath.join(directory, `${record.id}.json`);
  const temporaryPath = NodePath.join(
    directory,
    `.${record.id}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let handle: NodeFs.FileHandle | undefined;
  let published = false;

  try {
    handle = await NodeFs.open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    // Check inherited Windows permissions before writing the credential.
    if (process.platform === "win32") await verifyPrivateFile(temporaryPath);
    await handle.writeFile(JSON.stringify(encodeInstanceRecord(record)), {
      encoding: "utf8",
    });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await NodeFs.rename(temporaryPath, path);
    published = true;
    await verifyPrivateFile(path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await NodeFs.unlink(temporaryPath).catch(() => undefined);
    if (published) await NodeFs.unlink(path).catch(() => undefined);
    throw error;
  }

  let registered = true;
  return {
    async deregister() {
      if (!registered) return;
      registered = false;
      await NodeFs.unlink(path).catch((error: unknown) => {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      });
    },
  };
}
