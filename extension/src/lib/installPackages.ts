import * as NodeFs from "node:fs";

import { Cause, Effect } from "effect";

import { assert } from "../assert.ts";
import type { MarimoNotebookDocument } from "../notebook/schemas/vscode-notebook.ts";
import { Uv, UvUnknownError } from "../python/Uv.ts";
import { VsCode } from "../platform/VsCode.ts";

export function installPackages(
  packages: ReadonlyArray<string>,
  options: {
    venvPath: string;
  },
): Effect.Effect<void, never, Uv | VsCode>;
export function installPackages(
  packages: ReadonlyArray<string>,
  options: {
    script: MarimoNotebookDocument;
  },
): Effect.Effect<void, never, Uv | VsCode>;
export function installPackages(
  packages: ReadonlyArray<string>,
  options: {
    script?: MarimoNotebookDocument;
    venvPath?: string;
  },
): Effect.Effect<void, never, Uv | VsCode> {
  return Effect.gen(function* () {
    const uv = yield* Uv;
    const code = yield* VsCode;
    yield* code.window.withProgress(
      {
        location: code.ProgressLocation.Notification,
        title: `Installing ${packages.length > 1 ? "packages" : "package"}`,
        cancellable: true,
      },
      (progress) =>
        Effect.gen(function* () {
          progress.report({
            message: `Installing ${packages.join(", ")}...`,
          });

          if (options.venvPath) {
            const venvPath = options.venvPath;
            yield* uv.addProject({ directory: venvPath, packages }).pipe(
              Effect.catchTag(
                "UvMissingPyProjectError",
                Effect.fn(function* () {
                  yield* Effect.logWarning(
                    "Failed to `uv add`, attempting `uv pip install`.",
                  );
                  yield* uv.pipInstall(packages, { venv: venvPath });
                }),
              ),
            );
          } else {
            const notebook = options.script;
            assert(notebook, "Expected notebook");

            // safely update the the notebook
            yield* uvAddScriptSafe(packages, notebook).pipe(
              Effect.provideService(VsCode, code),
              Effect.provideService(Uv, uv),
            );

            // sync the virtual env
            yield* uv.syncScript({ script: notebook.uri.fsPath }).pipe(
              // Should be added by `uvAddScriptSafe`
              Effect.catchTag("UvMissingPep723MetadataError", () =>
                Effect.die("Expected PEP 723 metadata to be present"),
              ),
            );
          }
          progress.report({
            message: `Successfully installed ${packages.join(", ")}`,
          });
        }).pipe(
          Effect.catchAllCause(
            Effect.fn(function* (cause) {
              yield* Effect.logError("Failed to install").pipe(
                Effect.annotateLogs({ cause }),
              );

              // Extract actionable detail from the uv error, if available
              const detail = extractUvErrorDetail(cause);
              const suffix = detail
                ? `\n\n${detail}`
                : " See marimo logs for details.";

              yield* code.window.showErrorMessage(
                `Failed to install ${packages.join(", ")}.${suffix}`,
              );
            }),
          ),
        ),
    );
  });
}

export const uvAddScriptSafe = Effect.fn("uvAddScriptSafe")(function* (
  packages: ReadonlyArray<string>,
  notebook: MarimoNotebookDocument,
) {
  const uv = yield* Uv;
  const code = yield* VsCode;
  const tmpFile = `${notebook.uri.fsPath}.tmp`;
  yield* Effect.promise(() =>
    NodeFs.promises.writeFile(tmpFile, notebook.header),
  );

  yield* uv.addScript({ script: tmpFile, packages, noSync: true });

  const newHeader = yield* Effect.promise(async () =>
    NodeFs.promises.readFile(tmpFile, "utf-8"),
  );

  yield* Effect.promise(async () => NodeFs.promises.unlink(tmpFile));

  {
    yield* Effect.sleep("10 millis");
    const docs = yield* code.workspace.getNotebookDocuments();
    const doc = docs.find(
      (nb) => nb.uri.toString() === notebook.uri.toString(),
    );
    assert(doc, "no notebook");

    // apply new header as edit in our workspace...
    const edit = new code.WorkspaceEdit();
    edit.set(doc.uri, [
      code.NotebookEdit.updateNotebookMetadata({
        ...doc.metadata,
        header: { value: newHeader },
      }),
    ]);
    yield* code.workspace.applyEdit(edit);
  }

  {
    yield* Effect.sleep("10 millis");
    const docs = yield* code.workspace.getNotebookDocuments();
    const doc = docs.find(
      (nb) => nb.uri.toString() === notebook.uri.toString(),
    );
    assert(doc, "no notebook");
    yield* Effect.promise(() => doc.save());
  }
});

/**
 * Walk the Cause tree looking for a UvUnknownError and return the last
 * line of its stderr (typically the most actionable message).
 */
function extractUvErrorDetail(cause: Cause.Cause<unknown>): string | null {
  const failures = Cause.failures(cause);
  for (const failure of failures) {
    if (failure instanceof UvUnknownError && failure.stderr) {
      const lines = failure.stderr.trim().split("\n");
      return lines[lines.length - 1] ?? null;
    }
  }
  return null;
}
