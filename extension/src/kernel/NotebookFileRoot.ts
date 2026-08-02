import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { Data, Effect, Option } from "effect";
import type * as vscode from "vscode";

export const DEFAULT_NOTEBOOK_FILE_ROOT = "${fileDirname}";

export class NotebookFileRootError extends Data.TaggedError(
  "NotebookFileRootError",
)<{ readonly configuredValue: string; readonly message: string }> {}

interface ResolveNotebookFileRootOptions {
  readonly configuredValue: string;
  readonly notebookUri: vscode.Uri;
  readonly workspaceFolders: Option.Option<readonly vscode.WorkspaceFolder[]>;
  readonly homeDirectory?: string;
}

/** Resolve and validate the initial working directory for a notebook kernel. */
export const resolveNotebookFileRoot = Effect.fn("resolveNotebookFileRoot")(
  function* ({
    configuredValue,
    notebookUri,
    workspaceFolders,
    homeDirectory = NodeOs.homedir(),
  }: ResolveNotebookFileRootOptions) {
    const fail = (message: string) =>
      new NotebookFileRootError({ configuredValue, message });
    const value = configuredValue;
    if (value.trim().length === 0) {
      return yield* fail("The notebook file root cannot be empty.");
    }

    const folders = Option.getOrElse(workspaceFolders, () => []);
    const isSaved = notebookUri.scheme === "file";
    const notebookPath = isSaved ? notebookUri.fsPath : undefined;
    const containingWorkspace =
      notebookPath === undefined
        ? undefined
        : folders
            .filter((folder) => containsPath(folder.uri.fsPath, notebookPath))
            .toSorted(
              (left, right) => right.uri.fsPath.length - left.uri.fsPath.length,
            )[0];

    let resolved: string;
    let usedFirstWorkspaceFallback = false;
    if (value === DEFAULT_NOTEBOOK_FILE_ROOT) {
      if (notebookPath !== undefined) {
        resolved = NodePath.dirname(notebookPath);
      } else if (folders.length === 1) {
        resolved = folders[0].uri.fsPath;
      } else if (folders.length > 1) {
        resolved = folders[0].uri.fsPath;
        usedFirstWorkspaceFallback = true;
      } else {
        resolved = homeDirectory;
      }
    } else if (value === "${workspaceFolder}") {
      if (containingWorkspace === undefined) {
        return yield* fail(
          "${workspaceFolder} is unavailable because the notebook is not inside a workspace folder.",
        );
      }
      resolved = containingWorkspace.uri.fsPath;
    } else if (/\$\{[^}]+\}/.test(value)) {
      const variable = value.match(/\$\{[^}]+\}/)?.[0] ?? value;
      return yield* fail(`Unsupported variable ${variable}.`);
    } else if (value === "~" || /^~[\\/]/.test(value)) {
      resolved =
        value === "~"
          ? homeDirectory
          : NodePath.join(homeDirectory, value.slice(2));
    } else if (value.startsWith("~")) {
      return yield* fail(
        "Only '~' or paths beginning with '~/' can use home-directory expansion.",
      );
    } else if (NodePath.isAbsolute(value)) {
      resolved = value;
    } else {
      if (containingWorkspace === undefined) {
        return yield* fail(
          "Relative notebook file roots require the notebook to be inside a workspace folder.",
        );
      }
      resolved = NodePath.resolve(containingWorkspace.uri.fsPath, value);
    }

    resolved = NodePath.normalize(resolved);
    const stat = yield* Effect.tryPromise({
      try: () => NodeFs.promises.stat(resolved),
      catch: () => fail(`Notebook file root does not exist: ${resolved}`),
    });
    if (!stat.isDirectory()) {
      return yield* fail(`Notebook file root is not a directory: ${resolved}`);
    }

    return { path: resolved, usedFirstWorkspaceFallback };
  },
);

function containsPath(parent: string, child: string): boolean {
  const relative = NodePath.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !NodePath.isAbsolute(relative))
  );
}
