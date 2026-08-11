import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import type * as vscode from "vscode";

import { Uri } from "../../__mocks__/TestVsCode.ts";
import { resolveNotebookFileRoot } from "../NotebookFileRoot.ts";

const folder = (path: string) =>
  ({
    uri: Uri.file(path),
    name: NodePath.basename(path),
    index: 0,
  }) satisfies vscode.WorkspaceFolder;

const withTree = <A, E>(
  run: (paths: {
    root: string;
    nested: string;
    spaced: string;
    notebook: Uri;
    file: string;
  }) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      NodeFs.mkdtempDisposableSync(
        NodePath.join(NodeOs.tmpdir(), "marimo-file-root-"),
      ),
    ),
    (temporary) =>
      Effect.sync(() => {
        const nested = NodePath.join(temporary.path, "nested");
        const spaced = NodePath.join(temporary.path, " spaced ");
        const notebookPath = NodePath.join(nested, "notebook.py");
        const file = NodePath.join(temporary.path, "plain-file");
        NodeFs.mkdirSync(nested);
        NodeFs.mkdirSync(spaced);
        NodeFs.writeFileSync(notebookPath, "");
        NodeFs.writeFileSync(file, "");
        return {
          root: temporary.path,
          nested,
          spaced,
          notebook: Uri.file(notebookPath),
          file,
        };
      }).pipe(Effect.flatMap(run)),
    (temporary) => Effect.sync(() => temporary.remove()),
  );

it.effect("resolves all supported saved-notebook forms", () =>
  withTree(({ root, nested, spaced, notebook }) =>
    Effect.gen(function* () {
      for (const [configuredValue, expected] of [
        ["${fileDirname}", nested],
        ["${workspaceFolder}", root],
        ["nested", nested],
        [nested, nested],
        [spaced, spaced],
        ["~/nested", nested],
      ] as const) {
        const result = yield* resolveNotebookFileRoot({
          configuredValue,
          notebookUri: notebook,
          workspaceFolders: Option.some([folder(root)]),
          homeDirectory: root,
        });
        expect(result.path).toBe(expected);
      }
    }),
  ),
);

it.effect("uses the most specific containing workspace", () =>
  withTree(({ root, nested, notebook }) =>
    Effect.gen(function* () {
      const result = yield* resolveNotebookFileRoot({
        configuredValue: "${workspaceFolder}",
        notebookUri: notebook,
        workspaceFolders: Option.some([folder(root), folder(nested)]),
      });
      expect(result.path).toBe(nested);
    }),
  ),
);

it.effect("rejects unsupported variables and invalid directories", () =>
  withTree(({ root, notebook, file }) =>
    Effect.gen(function* () {
      for (const configuredValue of [
        "${unknown}",
        NodePath.join(root, "missing"),
        file,
      ]) {
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              resolveNotebookFileRoot({
                configuredValue,
                notebookUri: notebook,
                workspaceFolders: Option.some([folder(root)]),
              }),
            ),
          ),
        ).toBe(true);
      }
    }),
  ),
);

it.effect("handles saved notebooks outside workspace folders", () =>
  withTree(({ root, nested, notebook }) =>
    Effect.gen(function* () {
      const workspaceFolders = Option.some([
        folder(NodePath.join(root, "elsewhere")),
      ]);
      expect(
        (yield* resolveNotebookFileRoot({
          configuredValue: "${fileDirname}",
          notebookUri: notebook,
          workspaceFolders,
        })).path,
      ).toBe(nested);

      for (const configuredValue of ["${workspaceFolder}", "relative"]) {
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              resolveNotebookFileRoot({
                configuredValue,
                notebookUri: notebook,
                workspaceFolders,
              }),
            ),
          ),
        ).toBe(true);
      }
    }),
  ),
);

it.effect("uses the documented untitled default fallbacks", () =>
  withTree(({ root, nested }) =>
    Effect.gen(function* () {
      const untitled = Uri.from({ scheme: "untitled", path: "Untitled-1" });
      const cases = [
        [Option.some([folder(root)]), root, false],
        [Option.some([folder(root), folder(nested)]), root, true],
        [Option.none<readonly vscode.WorkspaceFolder[]>(), nested, false],
      ] as const;
      for (const [workspaceFolders, expected, usedFallback] of cases) {
        const result = yield* resolveNotebookFileRoot({
          configuredValue: "${fileDirname}",
          notebookUri: untitled,
          workspaceFolders,
          homeDirectory: nested,
        });
        expect(result).toEqual({
          path: expected,
          usedFirstWorkspaceFallback: usedFallback,
        });
      }
    }),
  ),
);
