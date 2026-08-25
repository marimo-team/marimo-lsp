import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vitest";

import {
  SavedSessionFiles,
  type WasmModule,
  WasmBridgeRuntime,
} from "../WasmBridgeRuntime.ts";

describe("SavedSessionFiles", () => {
  it("keeps the prior target until the staged write is committed", async () => {
    const directory = NodeFs.mkdtempSync(
      NodePath.join(NodeOs.tmpdir(), "marimo-saved-session-"),
    );
    try {
      const target = NodePath.join(directory, "session.json");
      NodeFs.writeFileSync(target, "old");
      if (process.platform !== "win32") NodeFs.chmodSync(target, 0o666);
      const files = new SavedSessionFiles();

      const replacement = files.create(target);
      await files.write(replacement, "new");

      expect(NodeFs.readFileSync(target, "utf8")).toBe("old");
      files.commit(replacement);
      expect(NodeFs.readFileSync(target, "utf8")).toBe("new");
      await expect(files.read(target)).resolves.toBe("new");
      if (process.platform !== "win32") {
        expect(NodeFs.statSync(target).mode & 0o777).toBe(0o666);
      }
    } finally {
      NodeFs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("discards a temp whose asynchronous write is still pending", async () => {
    const directory = NodeFs.mkdtempSync(
      NodePath.join(NodeOs.tmpdir(), "marimo-saved-session-"),
    );
    try {
      const files = new SavedSessionFiles();
      const replacement = files.create(
        NodePath.join(directory, "session.json"),
      );
      const temporary = NodeFs.readdirSync(directory).map((name) =>
        NodePath.join(directory, name),
      )[0];
      expect(temporary).toBeDefined();
      if (temporary === undefined) throw new Error("Missing replacement file");

      const write = files.write(replacement, "output");
      files.discard(replacement);
      await write;

      expect(NodeFs.existsSync(temporary)).toBe(false);
    } finally {
      NodeFs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects new replacements after close", () => {
    const files = new SavedSessionFiles();

    files.close();
    files.close();

    expect(() =>
      files.create(NodePath.join(NodeOs.tmpdir(), "session.json")),
    ).toThrow("closed");
  });

  it("discards replacements that finish after close", async () => {
    const directory = NodeFs.mkdtempSync(
      NodePath.join(NodeOs.tmpdir(), "marimo-saved-session-"),
    );
    try {
      const target = NodePath.join(directory, "session.json");
      const files = new SavedSessionFiles();
      const replacement = files.create(target);
      const write = files.write(replacement, "output");

      files.close();
      await write;

      expect(NodeFs.readdirSync(directory)).toEqual([]);
      expect(NodeFs.existsSync(target)).toBe(false);
    } finally {
      NodeFs.rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe("WasmBridgeRuntime", () => {
  it("closes the saved-session store before destroying the bridge", () => {
    let savedSessions: SavedSessionFiles | undefined;
    const calls: Array<string> = [];
    const module: WasmModule = {
      create_bridge: (_writeMessage, _processes, files) => {
        if (!(files instanceof SavedSessionFiles)) {
          throw new TypeError("Expected saved-session files");
        }
        savedSessions = files;
        return {
          handle_message: async () => undefined,
          handle_kernel_bytes: () => undefined,
          handle_kernel_exit: () => undefined,
          close: () => calls.push("bridge.close"),
          destroy: () => calls.push("bridge.destroy"),
        };
      },
      destroy: () => calls.push("module.destroy"),
    };
    const runtime = new WasmBridgeRuntime(module, () => undefined);

    runtime.close();

    expect(calls).toEqual(["bridge.close", "bridge.destroy", "module.destroy"]);
    expect(savedSessions).toBeDefined();
    expect(() =>
      savedSessions?.create(NodePath.join(NodeOs.tmpdir(), "session.json")),
    ).toThrow("closed");
  });
});
