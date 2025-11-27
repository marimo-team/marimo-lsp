import { Command, CommandExecutor } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import * as semver from "@std/semver";
import { Effect, Option, PubSub, Schema, Stream } from "effect";
import type * as vscode from "vscode";
import { SemVerFromString } from "../schemas.ts";
import { MINIMUM_MARIMO_VERSION } from "./EnvironmentValidator.ts";
import { createStorageKey, Storage } from "./Storage.ts";
import { VsCode } from "./VsCode.ts";

/**
 * Schema for a custom Python path entry.
 */
export class CustomPythonPath extends Schema.Class<CustomPythonPath>(
  "CustomPythonPath",
)({
  /** Unique identifier for this custom path */
  id: Schema.String,
  /** User-friendly nickname (e.g., "Bazel Python", "Project Env") */
  nickname: Schema.String,
  /** Absolute path to the Python executable */
  pythonPath: Schema.String,
  /** Optional environment variables (e.g., PYTHONPATH) */
  env: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.String }),
    { default: () => ({}) },
  ),
}) {}

/**
 * Parse a shell-like command string into Python path and environment variables.
 * Format: "ENV1=value1 ENV2=value2 /path/to/python"
 *
 * @example
 * parseCommandString("PYTHONPATH=/foo/bar /usr/bin/python3")
 * // { pythonPath: "/usr/bin/python3", env: { PYTHONPATH: "/foo/bar" } }
 */
export function parseCommandString(input: string): {
  pythonPath: string;
  env: Record<string, string>;
} {
  const trimmed = input.trim();
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";

  // Simple parser that handles quoted values
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (!inQuote && (char === '"' || char === "'")) {
      inQuote = true;
      quoteChar = char;
    } else if (inQuote && char === quoteChar) {
      inQuote = false;
      quoteChar = "";
    } else if (!inQuote && char === " ") {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) {
    parts.push(current);
  }

  const env: Record<string, string> = {};
  let pythonPath = "";

  for (const part of parts) {
    const eqIndex = part.indexOf("=");
    // Check if it's an env var assignment (has = and doesn't start with /)
    if (eqIndex > 0 && !part.startsWith("/")) {
      const key = part.slice(0, eqIndex);
      const value = part.slice(eqIndex + 1);
      env[key] = value;
    } else {
      // This should be the Python path (last non-env part)
      pythonPath = part;
    }
  }

  return { pythonPath, env };
}

/**
 * Format a CustomPythonPath back to a command string.
 */
export function formatCommandString(config: {
  pythonPath: string;
  env?: Record<string, string>;
}): string {
  const envParts = Object.entries(config.env ?? {})
    .map(([key, value]) => {
      // Quote value if it contains spaces
      if (value.includes(" ")) {
        return `${key}="${value}"`;
      }
      return `${key}=${value}`;
    })
    .join(" ");

  if (envParts) {
    return `${envParts} ${config.pythonPath}`;
  }
  return config.pythonPath;
}

/**
 * Auto-detect PYTHONPATH from a Python executable path.
 *
 * Why this exists:
 * - Standard Python environments (venv, conda, system) don't need PYTHONPATH -
 *   the Python interpreter already knows where its packages are.
 * - Bazel runfiles are special: the interpreter is hermetic and packages live
 *   in separate directories that Bazel's wrapper scripts normally configure.
 *   When using the interpreter directly, we need to set PYTHONPATH manually.
 *
 * Supported patterns:
 * - Bazel runfiles: Detects .runfiles in path, finds all site-packages dirs
 * - Everything else: Returns empty (Python handles it natively)
 *
 * @returns Record with PYTHONPATH if auto-detected, empty object otherwise
 */
export function autoDetectEnv(pythonPath: string): Record<string, string> {
  const fs = require("node:fs") as typeof import("node:fs");
  const nodePath = require("node:path") as typeof import("node:path");

  // Pattern: Bazel runfiles
  // Example: /path/to/target.runfiles/python_x_y/bin/python3
  // We find the .runfiles dir and look for all */site-packages within
  const runfilesMatch = pythonPath.match(/^(.+\.runfiles)\//);
  if (runfilesMatch) {
    const runfilesDir = runfilesMatch[1];
    const sitePackagesDirs: string[] = [];

    try {
      // Scan runfiles directory for site-packages
      const entries = fs.readdirSync(runfilesDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          const sitePackagesPath = nodePath.join(
            runfilesDir,
            entry.name,
            "site-packages",
          );
          try {
            if (fs.statSync(sitePackagesPath).isDirectory()) {
              sitePackagesDirs.push(sitePackagesPath);
            }
          } catch {
            // Directory doesn't exist, skip
          }
        }
      }

      if (sitePackagesDirs.length > 0) {
        return {
          PYTHONPATH: sitePackagesDirs.join(nodePath.delimiter),
        };
      }
    } catch {
      // Can't read runfiles directory, skip auto-detection
    }
  }

  // For venv, conda, system Python: no PYTHONPATH needed
  // The interpreter already knows its site-packages location
  return {};
}

/**
 * Schema for the array of custom Python paths stored in workspace state.
 */
const CustomPythonPathsArray = Schema.Array(CustomPythonPath);

/**
 * Storage key for custom Python paths (per-workspace).
 */
const CUSTOM_PYTHON_PATHS_KEY = createStorageKey(
  "marimo.customPythonPaths",
  CustomPythonPathsArray,
);

export type CustomPythonPathChangeEvent =
  | { type: "added"; path: CustomPythonPath }
  | { type: "updated"; path: CustomPythonPath }
  | { type: "removed"; id: string };

/**
 * Service for managing custom Python paths with nicknames.
 * These paths are stored per-workspace and can be used as notebook kernels.
 */
/**
 * Result of validating a Python path for marimo compatibility.
 */
export type PythonPathValidationResult =
  | { valid: true; marimoVersion: string; pyzmqVersion: string }
  | {
      valid: false;
      missing: string[];
      outdated?: { package: string; current: string; required: string };
    };

export class CustomPythonPathService extends Effect.Service<CustomPythonPathService>()(
  "CustomPythonPathService",
  {
    dependencies: [Storage.Default, NodeContext.layer],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const storage = yield* Storage;
      const executor = yield* CommandExecutor.CommandExecutor;

      // PubSub for broadcasting changes to listeners (e.g., ControllerRegistry)
      const changesPubSub =
        yield* PubSub.unbounded<CustomPythonPathChangeEvent>();

      const EnvCheck = Schema.Array(
        Schema.Struct({
          name: Schema.String,
          version: Schema.NullOr(SemVerFromString),
        }),
      );

      /**
       * Validate that a Python path has marimo and pyzmq installed.
       */
      const validatePythonPath = (
        pythonPath: string,
        env?: Record<string, string>,
      ): Effect.Effect<PythonPathValidationResult, never, never> =>
        Effect.gen(function* () {
          // Merge custom env with process env
          const mergedEnv = { ...process.env, ...env };

          const result = yield* Command.make(
            pythonPath,
            "-c",
            `import json
packages = []
try:
    import marimo
    packages.append({"name":"marimo","version":marimo.__version__})
except ImportError:
    packages.append({"name":"marimo","version":None})
try:
    import zmq
    packages.append({"name":"pyzmq","version":zmq.__version__})
except ImportError:
    packages.append({"name":"pyzmq","version":None})
print(json.dumps(packages))`,
          ).pipe(
            Command.env(mergedEnv as Record<string, string>),
            Command.string,
            Effect.andThen(Schema.decodeUnknown(Schema.parseJson(EnvCheck))),
            Effect.provideService(CommandExecutor.CommandExecutor, executor),
          );

          const missing: string[] = [];
          let marimoVersion = "";
          let pyzmqVersion = "";

          for (const pkg of result) {
            if (pkg.version == null) {
              missing.push(pkg.name);
            } else {
              if (pkg.name === "marimo") {
                marimoVersion = semver.format(pkg.version);
                if (
                  !semver.greaterOrEqual(pkg.version, MINIMUM_MARIMO_VERSION)
                ) {
                  return {
                    valid: false,
                    missing: [],
                    outdated: {
                      package: "marimo",
                      current: marimoVersion,
                      required: semver.format(MINIMUM_MARIMO_VERSION),
                    },
                  } satisfies PythonPathValidationResult;
                }
              }
              if (pkg.name === "pyzmq") {
                pyzmqVersion = semver.format(pkg.version);
              }
            }
          }

          if (missing.length > 0) {
            return {
              valid: false,
              missing,
            } satisfies PythonPathValidationResult;
          }

          return {
            valid: true,
            marimoVersion,
            pyzmqVersion,
          } satisfies PythonPathValidationResult;
        }).pipe(
          Effect.catchAll((_error) => {
            // If we can't run the command, it's likely the path doesn't exist
            // or isn't a valid Python executable
            return Effect.succeed({
              valid: false,
              missing: ["Python executable not found or invalid"],
            } satisfies PythonPathValidationResult);
          }),
        );

      /**
       * Get all custom Python paths from workspace storage.
       */
      const getAll = Effect.gen(function* () {
        const result = yield* storage.workspace.get(CUSTOM_PYTHON_PATHS_KEY);
        return Option.getOrElse(
          result,
          () => [] as readonly CustomPythonPath[],
        );
      }).pipe(
        Effect.catchTag("StorageDecodeError", () =>
          Effect.succeed([] as readonly CustomPythonPath[]),
        ),
      );

      /**
       * Get a custom Python path by ID.
       */
      const getById = (id: string) =>
        Effect.map(getAll, (paths) =>
          Option.fromNullable(paths.find((p) => p.id === id)),
        );

      /**
       * Save the full list of custom Python paths to storage.
       */
      const saveAll = (paths: readonly CustomPythonPath[]) =>
        storage.workspace.set(CUSTOM_PYTHON_PATHS_KEY, [...paths]);

      /**
       * Add a new custom Python path.
       */
      const add = (nickname: string, pythonPath: string) =>
        addWithEnv(nickname, pythonPath, {});

      /**
       * Add a new custom Python path with environment variables.
       */
      const addWithEnv = (
        nickname: string,
        pythonPath: string,
        env: Record<string, string>,
      ) =>
        Effect.gen(function* () {
          const id = `custom-python-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          const newPath = new CustomPythonPath({
            id,
            nickname,
            pythonPath,
            env,
          });

          const existing = yield* getAll;
          yield* saveAll([...existing, newPath]);

          yield* PubSub.publish(changesPubSub, {
            type: "added",
            path: newPath,
          });
          yield* Effect.logInfo("Added custom Python path").pipe(
            Effect.annotateLogs({ id, nickname, pythonPath, env }),
          );

          return newPath;
        });

      /**
       * Update an existing custom Python path.
       */
      const update = (
        id: string,
        updates: { nickname?: string; pythonPath?: string },
      ) =>
        Effect.gen(function* () {
          const existing = yield* getAll;
          const index = existing.findIndex((p) => p.id === id);

          if (index === -1) {
            yield* Effect.logWarning(
              "Custom Python path not found for update",
            ).pipe(Effect.annotateLogs({ id }));
            return Option.none<CustomPythonPath>();
          }

          const current = existing[index];
          const updated = new CustomPythonPath({
            id: current.id,
            nickname: updates.nickname ?? current.nickname,
            pythonPath: updates.pythonPath ?? current.pythonPath,
          });

          const newPaths = [...existing];
          newPaths[index] = updated;
          yield* saveAll(newPaths);

          yield* PubSub.publish(changesPubSub, {
            type: "updated",
            path: updated,
          });
          yield* Effect.logInfo("Updated custom Python path").pipe(
            Effect.annotateLogs({ id, updates }),
          );

          return Option.some(updated);
        });

      /**
       * Remove a custom Python path by ID.
       */
      const remove = (id: string) =>
        Effect.gen(function* () {
          const existing = yield* getAll;
          const filtered = existing.filter((p) => p.id !== id);

          if (filtered.length === existing.length) {
            yield* Effect.logWarning(
              "Custom Python path not found for removal",
            ).pipe(Effect.annotateLogs({ id }));
            return false;
          }

          yield* saveAll(filtered);
          yield* PubSub.publish(changesPubSub, { type: "removed", id });
          yield* Effect.logInfo("Removed custom Python path").pipe(
            Effect.annotateLogs({ id }),
          );

          return true;
        });

      /**
       * Stream of change events for custom Python paths.
       */
      const changes = () => Stream.fromPubSub(changesPubSub);

      /**
       * Prompt user to add a new custom Python path.
       * Returns the created path, or None if cancelled.
       *
       * For Bazel runfiles, PYTHONPATH is auto-detected from the .runfiles directory.
       * Users can also manually specify env vars: "PYTHONPATH=/foo /path/to/python"
       */
      const promptAdd = Effect.gen(function* () {
        // Prompt for Python path with optional env vars
        const inputResult = yield* code.window.showInputBox({
          prompt:
            "Enter Python path (Bazel runfiles auto-detected, or manual: PYTHONPATH=/foo /path/to/python)",
          placeHolder: "/path/to/python (PYTHONPATH auto-detected for Bazel)",
          validateInput: (value) => {
            if (!value || value.trim() === "") {
              return "Python path is required";
            }
            const parsed = parseCommandString(value);
            if (!parsed.pythonPath) {
              return "Could not parse Python path from input";
            }
            return undefined;
          },
        });

        if (Option.isNone(inputResult) || inputResult.value.trim() === "") {
          return Option.none<CustomPythonPath>();
        }

        // Parse the input to extract env vars and python path
        const { pythonPath, env: explicitEnv } = parseCommandString(
          inputResult.value,
        );

        // Check if this exact Python path is already registered
        const existingPaths = yield* getAll;
        const existingPath = existingPaths.find(
          (p) => p.pythonPath === pythonPath,
        );

        if (existingPath) {
          yield* code.window.showInformationMessage(
            `This Python path is already registered as "${existingPath.nickname}".\n\nPath: ${pythonPath}`,
            { modal: true },
          );
          return Option.none<CustomPythonPath>();
        }

        // Auto-detect env vars if not explicitly provided
        const autoEnv = autoDetectEnv(pythonPath);
        const env = { ...autoEnv, ...explicitEnv }; // Explicit overrides auto-detected

        if (Object.keys(autoEnv).length > 0) {
          yield* Effect.logInfo("Auto-detected environment variables").pipe(
            Effect.annotateLogs({ pythonPath, autoEnv }),
          );
        }

        // Validate the Python path has marimo installed
        yield* Effect.logInfo("Validating custom Python path").pipe(
          Effect.annotateLogs({ pythonPath, env }),
        );

        const validation = yield* code.window.withProgress(
          {
            location: code.ProgressLocation.Notification,
            title: "Validating Python environment...",
            cancellable: false,
          },
          () => validatePythonPath(pythonPath, env),
        );

        if (!validation.valid) {
          if (validation.outdated) {
            yield* code.window.showErrorMessage(
              `The Python environment has marimo ${validation.outdated.current}, ` +
                `but version ${validation.outdated.required} or higher is required.\n\n` +
                `Please upgrade marimo in your environment: pip install "marimo>=${validation.outdated.required}"`,
              { modal: true },
            );
            return Option.none<CustomPythonPath>();
          }

          const missingStr = validation.missing.join(", ");
          yield* code.window.showErrorMessage(
            `The Python environment is missing required packages: ${missingStr}\n\n` +
              `Please install them in your environment:\n` +
              `pip install marimo pyzmq\n\n` +
              `Or for Bazel, ensure PYTHONPATH includes the marimo site-packages.\n` +
              `Example: PYTHONPATH=/path/to/runfiles/pip-marimo_marimo/site-packages /path/to/python`,
            { modal: true },
          );
          return Option.none<CustomPythonPath>();
        }

        yield* Effect.logInfo("Custom Python path validated successfully").pipe(
          Effect.annotateLogs({
            pythonPath,
            env,
            marimoVersion: validation.marimoVersion,
            pyzmqVersion: validation.pyzmqVersion,
          }),
        );

        // Prompt for nickname
        const nickname = yield* code.window.showInputBox({
          prompt: "Enter a nickname for this Python environment",
          placeHolder: "e.g., Bazel Python, Project Env",
          value: `Custom Python (marimo ${validation.marimoVersion})`,
          validateInput: (value) => {
            if (!value || value.trim() === "") {
              return "Nickname is required";
            }
            return undefined;
          },
        });

        if (Option.isNone(nickname) || nickname.value.trim() === "") {
          return Option.none<CustomPythonPath>();
        }

        const created = yield* addWithEnv(
          nickname.value.trim(),
          pythonPath,
          env,
        );
        return Option.some(created);
      });

      /**
       * Show a quick pick menu to manage custom Python paths (view, edit, delete).
       * Uses inline buttons for easy deletion.
       */
      const promptManage = Effect.gen(function* () {
        const paths = yield* getAll;

        if (paths.length === 0) {
          const choice = yield* code.window.showInformationMessage(
            "No custom Python paths configured. Would you like to add one?",
            { items: ["Add Custom Python Path"] },
          );

          if (Option.isSome(choice)) {
            yield* promptAdd;
          }
          return;
        }

        type ManageQuickPickItem = vscode.QuickPickItem & {
          action: "edit" | "add";
          pathId?: string;
        };

        const deleteButton: vscode.QuickInputButton = {
          iconPath: new code.ThemeIcon("trash"),
          tooltip: "Delete this custom Python path",
        };

        const editButton: vscode.QuickInputButton = {
          iconPath: new code.ThemeIcon("edit"),
          tooltip: "Edit this custom Python path",
        };

        const items: ManageQuickPickItem[] = [
          {
            label: "$(add) Add New Custom Python Path",
            action: "add",
          },
          ...paths.map((p) => ({
            label: `$(terminal) ${p.nickname}`,
            description: p.pythonPath,
            action: "edit" as const,
            pathId: p.id,
            buttons: [editButton, deleteButton],
          })),
        ];

        // Use createQuickPick for button support
        const result = yield* Effect.async<{
          type: "select" | "edit" | "delete";
          item: ManageQuickPickItem;
        } | null>((resume) => {
          const quickPick = code.window.createQuickPickRaw<ManageQuickPickItem>();
          quickPick.items = items;
          quickPick.placeholder = "Select a custom Python path to manage";
          quickPick.title = "Manage Custom Python Paths";

          let resolved = false;

          quickPick.onDidTriggerItemButton((e) => {
            if (!resolved) {
              resolved = true;
              quickPick.hide();
              if (e.button === deleteButton) {
                resume(Effect.succeed({ type: "delete", item: e.item }));
              } else if (e.button === editButton) {
                resume(Effect.succeed({ type: "edit", item: e.item }));
              }
            }
          });

          quickPick.onDidAccept(() => {
            if (!resolved) {
              const selected = quickPick.selectedItems[0];
              resolved = true;
              quickPick.hide();
              resume(
                Effect.succeed(
                  selected ? { type: "select", item: selected } : null,
                ),
              );
            }
          });

          quickPick.onDidHide(() => {
            if (!resolved) {
              resolved = true;
              resume(Effect.succeed(null));
            }
            quickPick.dispose();
          });

          quickPick.show();
        });

        if (!result) {
          return;
        }

        // Handle add action
        if (result.item.action === "add" && result.type === "select") {
          yield* promptAdd;
          return;
        }

        if (!result.item.pathId) {
          return;
        }

        // Handle delete button click
        if (result.type === "delete") {
          const confirm = yield* code.window.showWarningMessage(
            `Are you sure you want to delete "${result.item.label.replace("$(terminal) ", "")}"?`,
            { modal: true, items: ["Delete"] },
          );

          if (Option.isSome(confirm)) {
            yield* remove(result.item.pathId);
            yield* code.window.showInformationMessage(
              `Deleted custom Python path: ${result.item.label.replace("$(terminal) ", "")}`,
            );
          }
          return;
        }

        // Handle edit (either via button or selecting the item)
        if (result.type === "edit" || result.type === "select") {
          const currentPath = yield* getById(result.item.pathId);
          if (Option.isNone(currentPath)) {
            return;
          }

          // Edit nickname
          const newNickname = yield* code.window.showInputBox({
            prompt: "Enter a new nickname (or leave unchanged)",
            value: currentPath.value.nickname,
          });

          if (Option.isNone(newNickname)) {
            return;
          }

          // Edit Python path
          const newPythonPath = yield* code.window.showInputBox({
            prompt: "Enter the Python executable path (or leave unchanged)",
            value: currentPath.value.pythonPath,
          });

          if (Option.isNone(newPythonPath)) {
            return;
          }

          yield* update(result.item.pathId, {
            nickname: newNickname.value.trim() || currentPath.value.nickname,
            pythonPath:
              newPythonPath.value.trim() || currentPath.value.pythonPath,
          });

          yield* code.window.showInformationMessage(
            `Updated custom Python path: ${newNickname.value || currentPath.value.nickname}`,
          );
        }
      });

      return {
        getAll,
        getById,
        add,
        update,
        remove,
        changes,
        promptAdd,
        promptManage,
        validatePythonPath,
      };
    }),
  },
) {}
